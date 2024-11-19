import { Express } from 'express';
import { FieldValue, Firestore } from 'firebase-admin/firestore';
import Joi from 'joi';

import {
  register_get_request,
  register_post_request,
  send_error_response,
  send_standard_response
} from './util';

type MessageThreadMember = {
  user_id: string
};

type MessageThread = {
  id: string,
  members: MessageThreadMember[]
};

async function enumerate_message_threads(
  db: Firestore,
  member_user_ids: string[],
  member_user_ids_strict: boolean): Promise<string[]> {
  const query_results = await Promise.all(member_user_ids.map((user_id) =>
    db.collectionGroup('message_thread_members')
      .where('user_id', '==', user_id)
      .get()));
  const message_thread_id_sets = query_results.map((query_result) =>
    new Set(query_result.docs.map((doc) => doc.ref.parent.parent!.id)));
  const smallest_messge_thread_id_set = message_thread_id_sets.reduce(
    (previousValue, currentValue) => {
      return previousValue.size < currentValue.size ?
        previousValue : currentValue;
    });
  let message_thread_ids: string[] = [];
  for (const message_thread_id of smallest_messge_thread_id_set) {
    let contained_in_all_sets = true;
    for (const message_thread_id_set of message_thread_id_sets) {
      if (!message_thread_id_set.has(message_thread_id)) {
        contained_in_all_sets = false;
        break;
      }
    }
    if (contained_in_all_sets) {
      message_thread_ids.push(message_thread_id);
    }
  }
  if (member_user_ids_strict) {
    const filter = await Promise.all(message_thread_ids.map(async id => {
      const message_thread = await get_message_thread(db, id);
      return message_thread?.members.length === member_user_ids.length;
    }));
    message_thread_ids = message_thread_ids.filter((_, index) => filter[index]);
  }
  return message_thread_ids;
}

async function get_message_thread(
  db: Firestore, id: string): Promise<MessageThread | undefined> {
  const doc = db.collection('message_threads').doc(id);
  const subcollections = await doc.listCollections();
  if (subcollections.length !== 0) {
    const retval: MessageThread = { id, members: [] };
    const members = await doc.collection('message_thread_members').get();
    members.forEach(
      (member) => { retval.members.push({ user_id: member.data().user_id }); });
    return retval;
  }
}

export function register_message_thread_requests(app: Express, db: Firestore) {
  // gets message thread ids given a member user id
  register_get_request(app, '/message_threads',
    {
      query_schema: Joi.object({
        member_user_id: Joi.alt(
          Joi.string(),
          Joi.array().items(Joi.string()).max(100)
        ).required(),
        member_user_id_strict: Joi.alt(Joi.valid('true'), Joi.valid('false'))
      }).strict()
    },
    async (req, res) => {
      const member_user_id = req.query.member_user_id as string | string[];
      const member_user_ids = typeof member_user_id === 'string' ?
        [member_user_id] : member_user_id;
      const member_user_ids_strict = req.query.member_user_id_strict === 'true';
      res.type('application/json');
      res.send(JSON.stringify({
        message_thread_ids: await enumerate_message_threads(
          db, member_user_ids, member_user_ids_strict)
      }));
    });
  // creates a message thread with the given members, responds with the id
  register_post_request(app, '/message_threads',
    {
      body_schema: Joi.object({
        members: Joi.array().items(Joi.object({
          user_id: Joi.string().required()
        })).min(1).required()
      }).strict()
    },
    async (req, res) => {
      const members: { user_id: string }[] = req.body.members;
      // TODO: fix race condition
      if ((await enumerate_message_threads(
        db, members.map((member) => member.user_id), true)).length === 0) {
        const message_thread_doc = db.collection('message_threads').doc();
        for (const member of req.body.members) {
          await message_thread_doc.collection('message_thread_members')
            .add(member);
        }
        res.type('application/json');
        res.send(JSON.stringify({ message_thread_id: message_thread_doc.id }));
      } else {
        send_error_response(res, 400, {
          error_code: 'already_exists',
          message: "Tried to create a message thread with some set of members" +
            ", but such a message thread already exists."
        });
      }
    });
  // gets an individual message thread
  register_get_request(app, '/message_threads/:id',
    {
      params_schema: Joi.object({ id: Joi.string().required() }).strict()
    },
    async (req, res) => {
      const message_thread_doc =
        db.collection('message_threads').doc(req.params.id);
      const message_thread_collections =
        await message_thread_doc.listCollections();
      if (message_thread_collections.length !== 0) {
        // message thread exists
        const response_body: {
          id: string,
          members: { user_id: string }[],
          messages: {
            id: string,
            author_user_id: string,
            author_session_id: string,
            create_timestamp: number,
            content: string
          }[]
        } = { id: req.params.id, members: [], messages: [] };
        const message_thread_members_snapshot = await message_thread_doc
          .collection('message_thread_members').get();
        message_thread_members_snapshot.forEach(
          (message_thread_member_snapshot) => {
            response_body.members.push({
              user_id: message_thread_member_snapshot.data().user_id
            });
          });
        if (message_thread_collections.map((ref) => ref.id)
          .includes('message_thread_messages')) {
          const message_thread_messages_snapshot =
            await message_thread_doc
              .collection('message_thread_messages')
              .orderBy('create_timestamp').get();
          message_thread_messages_snapshot.forEach(
            (message_thread_message_snapshot) => {
              const data = message_thread_message_snapshot.data();
              response_body.messages.push({
                id: message_thread_message_snapshot.id,
                author_user_id: data.author_user_id,
                author_session_id: data.author_session_id ?? "",
                create_timestamp:
                  data.create_timestamp.toDate().toISOString(),
                content: data.content
              });
            });
        }
        res.type('application/json');
        res.send(JSON.stringify(response_body));
      } else {
        // message thread does not exist
        send_standard_response(res, 404);
      }
    });
  register_post_request(app, '/message_threads/:id/messages',
    {
      body_schema: Joi.object({
        author_user_id: Joi.string().required(),
        author_session_id: Joi.string().required(),
        content: Joi.string().required()
      }).strict()
    },
    async (req, res) => {
      const message_thread_doc =
        db.collection('message_threads').doc(req.params.id);
      const message_thread_collections =
        await message_thread_doc.listCollections();
      if (message_thread_collections.length !== 0) {
        // message thread exists
        const message_doc =
          message_thread_doc.collection('message_thread_messages').doc();
        await message_doc.create({
          author_user_id: req.body.author_user_id,
          author_session_id: req.body.author_session_id,
          create_timestamp: FieldValue.serverTimestamp(),
          content: req.body.content
        });
        res.type('application/json');
        res.send(JSON.stringify({ message_id: message_doc.id }));
      } else {
        // message thread does not exist
        send_standard_response(res, 404);
      }
    });
}