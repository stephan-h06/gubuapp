import cors from 'cors';
import { scryptSync } from 'crypto';
import express from 'express';
import { applicationDefault, initializeApp } from 'firebase-admin/app';
import { getFirestore, FieldValue } from 'firebase-admin/firestore';
import Joi, { array } from 'joi';

import { register_friendship_requests } from './friendship';
import { register_user_requests } from './user';
import { register_post_request, send_standard_response } from './util';
import { register_message_thread_requests } from './message_thread';
import { getGameInfo, searchGames, matchGames } from './api_requests'

// login to firebase
initializeApp({ credential: applicationDefault() });
// initialize firestore globals
const db = getFirestore();
// initialize express globals
const app = express();
// enable cors
app.use(cors());
// parse json bodies as json
app.use(express.json());
// send "gubu!" back when a GET request comes in at the root, just so we know
// we're alive
app.get('/', (req, res) => {
    res.send(`gubu!`);
});
register_user_requests(app, db);
register_friendship_requests(app, db);
register_message_thread_requests(app, db);
register_post_request(app, '/auth', {
    body_schema: Joi.object({
        username: Joi.string().required(),
        password: Joi.string()
    }).strict()
}, async (req, res) => {
    const username: string = req.body.username;
    const password: string | undefined = req.body.password;
    const user_docs =
        await db.collection('users')
            .where('username', '==', username)
            .limit(1)
            .get();
    if (!user_docs.empty) {
        const user_doc = user_docs.docs[0];
        const user_data = user_doc.data();
        if (user_data.password_hash !== undefined) {
            if (password !== undefined) {
                const password_salt =
                    Buffer.from(user_data.password_salt, 'hex');
                const password_hash =
                    Buffer.from(user_data.password_hash, 'hex');
                if (!scryptSync(password.normalize(), password_salt, 64)
                    .equals(password_hash)) {
                    send_standard_response(res, 400);
                }
            } else {
                send_standard_response(res, 400);
            }
        }
        res.contentType('application/json');
        res.send(JSON.stringify({ user_id: user_doc.id }));
    } else {
        send_standard_response(res, 400);
    }
});

//get players
function shuffleArray(array: string[]) {
    // Clone original array 
    const shuffledArray = array.slice();
  
    for (let i = shuffledArray.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      // Swap elements at index i and j
      [shuffledArray[i], shuffledArray[j]] = [shuffledArray[j], shuffledArray[i]];
    }
  
    return shuffledArray;
  }

app.get('/players', async (req, res) => {
    //search for matches using players?match=user_id
    if (req.query.match !== undefined) {
        const players_doc = await db.collection("players");
        //not sure how to do this without var
        //get what games the user plays
        var users_snapshot = await players_doc.where("user_id", "==", req.query.match).get();
        const games_played: string[] = [];
        const matches: string[] = [];
        if (users_snapshot.empty) {
            send_standard_response(res, 404);
        }
        else {
            users_snapshot.forEach((result) => { games_played.push(result.data().game_id) });
        }

        //find all players docs which contain games that the user plays
        var matches_snapshot = await players_doc.where("game_id", "in", games_played).get();
        matches_snapshot.forEach((result2) => {
            if (result2.data().user_id !== req.query.match && !matches.includes(result2.data().user_id)) {
                matches.push(result2.data().user_id);
            }
        })
        
        //shuffle array before sending
        const shuffled_matches: string[] = shuffleArray(matches);
        res.send(JSON.stringify({ shuffled_matches }));
        return;
    }
    const players_docs = await db.collection('players').get();
    const players_ids: string[] = [];
    players_docs.forEach((result) => { players_ids.push(result.id) });
    res.send(JSON.stringify({ players_ids }));
});

//get games
app.get('/games', async (req, res) => {
    let genre = req.query.genre;
    const games_doc = db.collection('games');
    var games_snapshot;
    if (Boolean(genre)) {
        //create array of genres from the queryied genres
        const genre_query = Array.isArray(req.query.genre) ? req.query.genre : [req.query.genre];
        games_snapshot = await games_doc.where('genres', 'array-contains-any', genre_query).get();
        if (games_snapshot.empty) {
            send_standard_response(res, 404);
        }
        else {
            const game_query_ids: string[] = [];
            games_snapshot.forEach((result) => { game_query_ids.push(result.id) });
            res.send(JSON.stringify({ game_query_ids }));
        }
        return;
    }
    const games_docs = await db.collection('games').get();
    const games_ids: string[] = [];
    games_docs.forEach((result) => { games_ids.push(result.id) });
    res.send(JSON.stringify({ games_ids }));
});

//post games, sets gamename to 'gamename'
app.post('/games', async (req, res) => {
    await db.runTransaction(async (tr) => {
        const games_docs = await tr.get(db.collection('games').where(
            'gamename', '==', req.body.name).limit(1));
        if (games_docs.empty) {
            const new_game_doc = db.collection('games').doc();
            tr.create(new_game_doc, {
                igdb_id: req.body.igdb_id ?? null,
                gamename: req.body.name,
                genres: []
            });
            res.contentType('application/json');
            res.send(JSON.stringify({ game_id: new_game_doc.id }));
        } else {
            res.status(400);
            res.send(games_docs.docs);
        }
    });
});


//patch game to update genres
{
    const params_schema = Joi.object({ id: Joi.string().required() }).required().strict();
    const body_schema = Joi.object({
        genres: Joi.array().items(Joi.string())
    }).required().strict();
    app.patch('/games/:id', async (req, res) => {
        try {
            Joi.assert(req.params, params_schema);
            Joi.assert(req.body, body_schema);
        } catch (e) {
            send_standard_response(res, 400, e);
            return;
        }
        if (Object.keys(req.body).length === 0) {
            send_standard_response(res, 400, "Empty Body");
            return;
        }
        let game_exists = (await db.collection('games').doc(req.params.id).get()).exists;
        if (game_exists) {
            if (req.body.genres !== undefined) {
                for (const genre of req.body.genres) { //for each genre in query array "genre"
                    await db.collection('games').doc(req.params.id).update({
                        genres: FieldValue.arrayUnion(genre) //add the genre to the database's genre array
                    });
                }
            }
            send_standard_response(res, 200);
        } else {
            send_standard_response(res, 404, "No Such Game");
        }
    });
}

//get the game by the igdb id
//or search based on the game_id
app.get('/games/info/:id', async (req, res) => {
    //Assume it is igdb id first
    await db.runTransaction(async (tr) => {
        const igdb_games = await tr.get(db.collection('games')
            .where('igdb_id', 'in', [Number(req.params.id), req.params.id])
            .limit(1)
        );
        //no return based on igdb, check if gameid was sent
        if (igdb_games.empty) {
            const games_doc = await db.collection('games').doc(req.params.id).get();
            //Found a game with the id
            if (games_doc.exists) {
                const game_data = games_doc.data();
                //Extract ID
                const igdb_id = parseInt(game_data?.igdb_id) ?? -1;
                //id not there
                if (igdb_id == -1) {
                    res.status(404);
                    res.send("Not Found");
                }
                else {
                    const data = await getGameInfo(Number(igdb_id));
                    res.status(200);
                    res.send(["games/" + req.params.id, data]);
                }

            }
            //Really couldn't find anything
            else {
                res.status(404);
                res.send("Not Found");
            }
            //found based on igdb id
        } else {
            res.status(200);
            let data = await getGameInfo(Number(req.params.id));
            res.send([igdb_games.docs[0]['ref']['path'], data]);
        }
    });
})
//get games/:id
app.get('/games/:id', async (req, res) => {
    const games_doc = await db.collection('games').doc(req.params.id).get();
    if (games_doc.exists) {
        const game_data = games_doc.data();
        res.contentType('application/json');
        res.send(JSON.stringify({
            id: games_doc.id,
            igdb_id: game_data?.igdb_id ?? null,
            name: game_data?.gamename ?? null
        }));
    } else {
        res.status(404);
        res.send("Not Found");
    }
});

//delete games/:id
app.delete('/games/:id', async (req, res) => {
    await db.collection('games').doc(req.params.id).delete();
    res.status(200);
    res.send("OK");
});

//search for a particluar game
app.get('/gamesearch/:name-:filters', async (req, res) => {
    let data = await searchGames(req.params.name, req.params.filters);
    if (data == 'false') {
        res.status(400);
        res.send(`failed: ${data}, ${req.params.name}, ${req.params.filters}`)
    }
    else {
        res.status(200);
        res.send(data);
    }
});

app.get('/matchgames/:id', async (req, res) => {
    let data = await matchGames(req.params.id, db);
    if (data == "400") {
        res.status(400);
        res.send("Error");
    }
    else {
        res.status(200);
        res.send(data);
    }
});


// start listening for connections
const port = parseInt(process.env.PORT || '') || 8080;
app.listen(port);