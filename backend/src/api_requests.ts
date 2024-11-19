import { Express } from 'express';
import { Firestore } from 'firebase-admin/firestore';
import Joi from 'joi';

/* IGDB functions */
// Our client id
const client_id = 'puefyzhex443cj5mstgw4qsepxtm8p';
//Used to get the access token
export async function getToken(): Promise<string> {
    const authUrl = 'https://id.twitch.tv/oauth2/token';
    const authParams = {
        client_id: client_id,
        client_secret: 'tcth0rzayv8pra1sc4gu4skwo0ccyp',
        grant_type: 'client_credentials',
    };

    const requestOptions: RequestInit = {
        method: 'POST',
    };

    const urlSearchParams = new URLSearchParams(authParams);
    const requestBody = urlSearchParams.toString();

    const response = await fetch(authUrl, {
        ...requestOptions,
        body: requestBody,
        headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
        },
    });

    const data = await response.json();
    const accessToken = data.access_token;

    return accessToken;
}

export async function getGameInfo(igdb_id: number): Promise<any> {
    const url = 'https://api.igdb.com/v4/games';
    const access_token = await getToken(); // Replace with your access token

    const headers = {
        'Client-ID': client_id,
        'Authorization': 'Bearer ' + access_token,
        'Content-Type': 'text/plain',
    };
    let body = "fields name, id, release_dates.y, cover.image_id, summary, genres.name, artworks.image_id, screenshots.image_id, platforms.name, platforms.platform_family.name, websites.category, websites.url; where id = " + igdb_id + ";";
    const response = await fetch(url, {
        method: 'POST',
        headers: headers,
        body: body,
    });

    if (response.ok) {
        const data = await response.json();
        return data;
    }
    else {
        return 'false';
    }
}
//Returns 100 games with the search term in the title
export async function searchGames(searchterm: string, filters: string): Promise<any> {
    const url = 'https://api.igdb.com/v4/games';
    const access_token = await getToken(); // Replace with your access token

    const headers = {
        'Client-ID': 'puefyzhex443cj5mstgw4qsepxtm8p',
        'Authorization': 'Bearer ' + access_token,
        'Content-Type': 'text/plain',
    };
    let body = 'fields name, id, release_dates.y, cover.image_id, platforms.name, screenshots.image_id, artworks.image_id; search "' + searchterm + '"; where parent_game = null & version_parent = null' + filters + '; limit 36;';
    if (searchterm.length == 0 || searchterm == " ") {
        body = "fields name, id, release_dates.y, cover.image_id, platforms.name, screenshots.image_id, artworks.image_id; where parent_game = null & version_parent = null & rating_count >= 250" + filters + "; limit 36;";
    }

    const response = await fetch(url, {
        method: 'POST',
        headers: headers,
        body: body,
    });

    if (response.ok) {
        const data = await response.json();
        return data;
    }
    else {
        return body;
    }
}
export async function matchGames(user: string, db: Firestore): Promise<any>{
    const access_token = await getToken();
    const url = 'https://api.igdb.com/v4/games';
    const headers = {
        'Client-ID': client_id,
        'Authorization': 'Bearer ' + access_token,
        'Content-Type': 'text/plain',
    };
    //get the list of igdb ids the user plays
    let games_played = [];
    //Get tthe user
    const user_doc = await db.collection('users').doc(user).get();
    if (user_doc.exists) {   
        //get all of the game id's played
        const player_docs = await db.collection('players')
          .where('user_id', '==', user).get();
        const played_game_ids = player_docs.docs.map(
          (player_doc) => player_doc.data().game_id);
        for (let game_id in played_game_ids){
            const games_doc = await db.collection('games').doc(played_game_ids[game_id]).get();
            if (games_doc.exists) {
                const game_data = games_doc.data();
                const id = game_data?.['igdb_id'] ?? -1;
                if (id != -1){
                    games_played.push(parseInt(id));
                }

            }
        }
    }
    //User couldn't be found
    else{
        return "400";
    }

    //add each genre up and get each platform the use may play
    let genre_map: { [key: number] : number} = {};
    let platforms: Array<number> = [];
    
    for (let id in games_played){
        //get the genre of the game
        let body = "fields id, genres, platforms; where id =  " + id + ";"
        const response = await fetch(url, {
            method: 'POST',
            headers: headers,
            body: body,
        });
        //If couldn't get info for that game, just ignore it
        if (response.ok) {
            try{
                const data = await response.json();
                
                const game_genres = data[0]['genres']
                
                for (let i in game_genres){
                    let genre = game_genres[i];
                    //Already in dict
                    if (genre in genre_map){
                        genre_map[genre] += 1;
                    }
                    else{
                        genre_map[genre] = 1;
                    }
                }
                const game_platforms = data[0]['platforms']
                for (let i in game_platforms){
                    const p = game_platforms[i]
                    if (!(p in platforms)){
                        platforms.push(p)
                    }
                }


            } catch(e){}
        }
    }
    //list to send as a query
    let l: any[] = [];
    let searching = platforms.length > 0;
    for (let key in genre_map){
        if (genre_map[key] > 0){
            l = [...l, key]
            //at least 1 genre to search for
            searching = true;
        }
    }

    //Try it a max of 1000 times, otherwise game couldn't be found
    for ( let i = 0; i < 1000 && searching; i++){
        //search for games within the genre, with a decent rating with at least some reviews
        let body = "fields name; where genres = [" + l + "] & rating > 60 & rating_count > 10 & id != ("+ games_played+ ") & platforms = ("+platforms+") & parent_game = null & version_parent = null; limit 100;";
        //Search for games
        const response = await fetch(url, {
            method: 'POST',
            headers: headers,
            body: body,
        });
        //Check if any data was returned if it was, return the games
        if (response.ok) {     
            const data = await response.json()
            if (data.length > 0){
                return data;
            }
        }

        //Otherwise decrease the search constraints
        l = []
        searching = false;
        for (let key in genre_map){
            genre_map[key] -= 1;
            if (genre_map[key] > 0){
                l = [...l, key];
                searching = true;
            }
        }
    }
    //Could not find any games, find some popular games
    let body = "fields name; where rating > 75 & rating_count > 100 & parent_game = null & version_parent = null; limit 100;";
        //Search for games
        const response = await fetch(url, {
            method: 'POST',
            headers: headers,
            body: body,
        });
        //Check if any data was returned if it was, return the games
        if (response.ok) {     
            const data = await response.json()
            if (data.length > 0){
                return data;
            }
        }
    //Smt went wrong
    return "400"
}