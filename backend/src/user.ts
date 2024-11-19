import { Express } from 'express';
import { Firestore } from 'firebase-admin/firestore';
import Joi from 'joi';

import {
  register_get_request,
  register_patch_request,
  register_post_request,
  send_standard_response
} from './util';
import { randomBytes, scryptSync } from 'crypto';

export function register_user_requests(app: Express, db: Firestore) {
  // returns a json object containing one field, an array of user ids called
  // "user_ids". each user id is a string.
  register_get_request(
    app,
    '/users',
    { query_schema: Joi.object({ display_name: Joi.string(), match: Joi.string() }).strict() },
    async (req, res) => {
      let user_snapshot;
      //search by display name
      if (req.query.display_name !== undefined) {
        user_snapshot = await db.collection('users')
          .where('display_name', '==', req.query.display_name).get();
        if (user_snapshot.empty) {
          res.type('application/json')
          res.send(JSON.stringify({ user_ids: [] }));
        }
        else {
          const user_ids: string[] = [];
          user_snapshot.forEach((result) => { user_ids.push(result.id) });
          res.type('application/json')
          res.send(JSON.stringify({ user_ids: user_ids }));
        }
        return;
      }
      user_snapshot = await db.collection('users').get();
      const user_ids: string[] = [];
      user_snapshot.forEach((result) => { user_ids.push(result.id) });
      res.contentType('application/json');
      res.send(JSON.stringify({ user_ids }));
    });
  // creates a new user with the username provided by the "username" property of
  // the request body. if successful, returns a json object with one property,
  // "user_id", containing the user id.
  register_post_request(app, '/users',
    {
      body_schema: Joi.object({
        username: Joi.string().required(),
        password: Joi.string().required(),
        display_name: Joi.string().required()
      }).strict()
    },
    async (req, res) => {
      await db.runTransaction(async (tr) => {
        const user_docs = await tr.get(
          db.collection('users')
            .where('username', '==', req.body.username)
            .limit(1));
        if (user_docs.empty) {
          const new_user_doc = db.collection('users').doc();
          const password_salt = randomBytes(16);
          const password_hash =
            scryptSync(req.body.password.normalize(), password_salt, 64);
          tr.create(new_user_doc, {
            username: req.body.username,
            password_salt: password_salt.toString('hex'),
            password_hash: password_hash.toString('hex'),
            display_name: req.body.display_name
          });
          res.contentType('application/json');
          res.send(JSON.stringify({ user_id: new_user_doc.id }));
        } else {
          send_standard_response(res, 400);
        }
      });
    });
  // gets a user given their id.
  register_get_request(app, '/users/:id',
    {
      params_schema: Joi.object({
        id: Joi.string().required()
      }).strict()
    },
    async (req, res) => {
      const user_doc = await db.collection('users').doc(req.params.id).get();
      if (user_doc.exists) {
        const user_data = user_doc.data();
        const player_docs = await db.collection('players')
          .where('user_id', '==', req.params.id).get();
        const played_game_ids = player_docs.docs.map(
          (player_doc) => player_doc.data().game_id);
        const friendship_query_results = await Promise.all([
          db.collection('friendships')
            .where('sender', '==', req.params.id)
            .where('accepted', '==', true)
            .limit(1)
            .get(),
          db.collection('friendships')
            .where('receiver', '==', req.params.id)
            .where('accepted', '==', true)
            .limit(1)
            .get()]);
        const friends_user_ids = [];
        for (const friend_user_id of friendship_query_results[0].docs.map(
          (friendship_doc) => friendship_doc.data().receiver)) {
          friends_user_ids.push(friend_user_id);
        }
        for (const friend_user_id of friendship_query_results[1].docs.map(
          (friendship_doc) => friendship_doc.data().sender)) {
          friends_user_ids.push(friend_user_id);
        }
        res.contentType('application/json');
        res.send(JSON.stringify({
          id: user_doc.id,
          display_name: user_data?.display_name ?? null,
          played_game_ids,
          friends_user_ids
        }));
      } else {
        send_standard_response(res, 404);
      }
    });
  // updates user info
  register_patch_request(app, '/users/:id',
    {
      params_schema: Joi.object({
        id: Joi.string().required()
      }).strict(),
      body_schema: Joi.object({
        display_name: Joi.string(),
        password: Joi.string(),
        // replace game ids
        played_game_ids: Joi.array().items(Joi.string()),
        // add game ids if not present
        add_played_game_ids: Joi.array().items(Joi.string()),
        // remove game ids if present
        remove_played_game_ids: Joi.array().items(Joi.string())
      }).strict()
    },
    async (req, res) => {
      if (Object.keys(req.body).length === 0) {
        send_standard_response(res, 400, "Empty Body");
        return;
      }
      const update_arg: Record<string, unknown> = {};
      if (req.body.display_name !== undefined) {
        update_arg.display_name = req.body.display_name;
      }
      if (req.body.password !== undefined) {
        const password_salt = randomBytes(16);
        const password_hash =
          scryptSync(req.body.password.normalize(), password_salt, 64);
        update_arg.password_salt = password_salt.toString('hex');
        update_arg.password_hash = password_hash.toString('hex');
      }
      let user_exists = undefined;
      if (Object.keys(update_arg).length !== 0) {
        try {
          await db.collection('users').doc(req.params.id).update(update_arg);
          user_exists = true;
        } catch {
          user_exists = false;
        }
      } else {
        user_exists =
          (await db.collection('users').doc(req.params.id).get()).exists;
      }
      if (user_exists) {
        if (req.body.played_game_ids !== undefined) {
          const players_collection = db.collection('players');
          const played_games =
            (await players_collection
              .where('user_id', '==', req.params.id)
              .get())
              .docs;
          const promises = [];
          for (const doc of played_games) {
            if (!req.body.played_game_ids.includes(doc.data().game_id)) {
              promises.push(doc.ref.delete());
            }
          }
          for (const game_id of req.body.played_game_ids) {
            promises.push(
              players_collection.doc(req.params.id + '-' + game_id)
                .set({ user_id: req.params.id, game_id }));
          }
          await Promise.all(promises);
        }
        if (req.body.add_played_game_ids !== undefined) {
          await Promise.all(
            req.body.add_played_game_ids
              .map((game_id: string) =>
                db.collection('players')
                  .doc(req.params.id + '-' + game_id)
                  .set({ user_id: req.params.id, game_id })));
        }
        if (req.body.remove_played_game_ids !== undefined) {
          await Promise.all(
            req.body.remove_played_game_ids
              .map((game_id: string) =>
                db.collection('players')
                  .doc(req.params.id + '-' + game_id)
                  .delete()));
        }
        send_standard_response(res, 200);
      } else {
        send_standard_response(res, 404, "No Such User");
      }
    });
}