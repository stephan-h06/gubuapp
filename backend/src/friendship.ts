import { Express } from 'express';
import { Firestore, Query } from 'firebase-admin/firestore';
import Joi from 'joi';

import {
  register_delete_request,
  register_get_request,
  register_patch_request,
  register_post_request,
  send_standard_response
} from './util';

export function register_friendship_requests(app: Express, db: Firestore) {
  // enumerates the friendship ids of the 
  register_get_request(
    app,
    '/friendships',
    {
      query_schema: Joi.object({
        // when present, only friendship objects with the specified sender pass
        // the filter
        sender: Joi.string(),
        // when present, only friendship objects with the specified receiver
        // pass the filter
        receiver: Joi.string(),
        // when present, only friendship objects with the specified user as
        // either the sender or receiver pass the filter. can be specified
        // twice. ignored if sender or receiver are present.
        member: Joi.alt(
          Joi.string(),
          Joi.array().items(Joi.string()).length(2)),
        // when present, only friendship objects where accepted is as specified
        // pass the fitler
        accepted: Joi.bool()
      }).strict()
    },
    async (req, res) => {
      let sender = req.query.sender as string | undefined;
      let receiver = req.query.receiver as string | undefined;
      let member = req.query.member as string | string[] | undefined;
      let accepted = req.query.accepted as boolean | undefined;
      let query: Query = db.collection('friendships');
      if (sender !== undefined) {
        query = query.where('sender', '==', sender);
        if (receiver !== undefined) {
          query = query.where('receiver', '==', receiver).limit(1);
        }
      } else if (receiver !== undefined) {
        query = query.where('receiver', '==', receiver);
      }
      if (accepted !== undefined) {
        query = query.where('accepted', '==', accepted);
      }
      let queries = [];
      if (sender === undefined &&
        receiver === undefined &&
        member != undefined) {
        if (typeof member === 'string') {
          queries.push(query.where('sender', '==', member));
          queries.push(query.where('receiver', '==', member));
        } else {
          queries.push(query
            .where('sender', '==', member[0])
            .where('receiver', '==', member[1])
            .limit(1));
          queries.push(query
            .where('sender', '==', member[1])
            .where('receiver', '==', member[0])
            .limit(1));
        }
      } else {
        queries.push(query);
      }
      const query_results = await Promise.all(
        queries.map((query) => query.get()));
      const friendship_ids: string[] = [];
      for (const query_result of query_results) {
        for (const doc of query_result.docs) {
          friendship_ids.push(doc.id);
        }
      }
      res.send(JSON.stringify({ friendship_ids }));
    });
  //get friendship using id
  register_get_request(
    app,
    '/friendships/:id',
    { params_schema: Joi.object({ id: Joi.string().required() }) },
    async (req, res) => {
      const friendships_doc =
        await db.collection('friendships').doc(req.params.id).get();
      if (friendships_doc.exists) {
        const friendships_data = friendships_doc.data();
        res.contentType('application/json');
        res.send(JSON.stringify({
          id: friendships_doc.id,
          sender: friendships_data?.sender ?? null,
          receiver: friendships_data?.receiver ?? null,
          accepted: friendships_data?.accepted
        }));
      } else {
        send_standard_response(res, 404);
      }
    });
  // create friendship with a sender and a receiver. Accepted is set to false
  register_post_request(
    app,
    '/friendships',
    {
      body_schema: Joi.object({
        sender: Joi.string().required(),
        receiver: Joi.string().required()
      }).strict()
    },
    async (req, res) => {
      if (req.body.sender == req.body.receiver) {
        send_standard_response(res, 400, "sender and receiver may not be equal");
        return;
      }
      const friendship_id = await db.runTransaction(async (tr) => {
        //one sender can only make one friendship with one receiver
        const friendship_docs_1 = await tr.get(db.collection('friendships')
          .where('sender', '==', req.body.sender)
          .where('receiver', '==', req.body.receiver).limit(1));
        const friendship_docs_2 = await tr.get(db.collection('friendships')
          .where('sender', '==', req.body.receiver)
          .where('receiver', '==', req.body.sender).limit(1));
        if (friendship_docs_1.empty && friendship_docs_2.empty) {
          const new_friendship_doc = db.collection('friendships').doc();
          tr.create(new_friendship_doc, {
            sender: req.body.sender,
            receiver: req.body.receiver,
            accepted: false
          });
          return new_friendship_doc.id;
        } else {
          return undefined;
        }
      });
      if (friendship_id !== undefined) {
        res.contentType('application/json');
        res.send(JSON.stringify({ friendship_id }));
      } else {
        send_standard_response(
          res, 400, "A friendship with these two members already exists");
      }
    });
  // patch request for friendships/:id. This sets "accepted" to true for that
  // friendship id.
  register_patch_request(
    app,
    '/friendships/:id',
    { params_schema: Joi.object({ id: Joi.string().required() }).strict() },
    async (req, res) => {
      try {
        await db.collection('friendships').doc(req.params.id)
          .update({ accepted: true });
        send_standard_response(res, 200);
      } catch (e) {
        send_standard_response(res, 404);
      }
    });
  //delete friendship/:id
  register_delete_request(
    app,
    '/friendships/:id',
    {
      params_schema: Joi.object({ id: Joi.string().required() }).strict()
    },
    async (req, res) => {
      await db.collection('friendships').doc(req.params.id).delete();
      res.status(200);
      res.send("OK");
    });
}