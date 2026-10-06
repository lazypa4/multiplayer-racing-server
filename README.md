# 🏁 Turbo Rivals

A top-down multiplayer car racing game that runs in the browser. Up to 8 racers
per room (humans and bots), 3 tracks, drifting, turbo capsules, several camera
views, lap timing and live standings.

## Run it

You need [Node.js](https://nodejs.org) 18 or newer.

```bash
npm install
npm start
```

Then open **http://localhost:3000**. The server also prints a network address
(e.g. `http://192.168.1.20:3000`). Friends on the same Wi-Fi open that one.

Use a different port with `PORT=8080 npm start`.

## Playing with friends

1. Click **Create room**. You get a 4-letter room code and an invite link.
2. Friends open the invite link (or enter the code and click **Join**).
3. The host picks a track and lap count, and can add bots to fill the grid.
4. The host clicks **Start race**. When the race ends, everyone returns to the lobby for the next round.

Anyone who joins while a race is running watches it as a spectator and races in the next round.

To play over the internet instead of the local network, put the game on a live
server (see below), or expose your local port with a tunnel such as
`ngrok http 3000` or `cloudflared tunnel --url http://localhost:3000`.

## Put it online

The multiplayer server needs a host that runs **Node.js 18+** with
**WebSockets**. Static hosts such as Netlify, GitHub Pages or plain HTML/PHP
hosting can't run it. They can still host the *website* if the server runs
somewhere else.

Build the upload packages with:

```bash
npm run package -- https://your-server.onrender.com
```

This creates two zips next to the project:

- `turbo-rivals-server.zip`: the game server (also serves the full game by itself).
- `turbo-rivals-netlify.zip`: the website only, with `index.html` at the top
  level and the server URL written into `config.js`. Leave the URL off and
  `config.js` gets a placeholder to fill in by hand.

### Netlify (website) + Render (game server)

1. **Server on Render (free).** Unzip `turbo-rivals-server.zip`, create a GitHub
   repository, and upload those files to it (*Add file → Upload files*). In
   Render, choose *New → Blueprint* and pick the repo. It reads `render.yaml`
   and sets everything up. (Or use *New → Web Service* with build command
   `npm install` and start command `npm start`.) When it's live, copy its URL,
   e.g. `https://turbo-rivals-abcd.onrender.com`.
2. **Website on Netlify.** Unzip `turbo-rivals-netlify.zip`, open `config.js`,
   and set `window.TURBO_RIVALS_SERVER` to the Render URL. Then drag the folder
   onto your Netlify site's *Deploys* page. (Or run
   `npm run package -- <render url>` and upload the zip as-is.)
3. Open your Netlify URL and create a room. Invite links point to your Netlify
   site.

Render's free plan puts the server to sleep after about 15 idle minutes. The
first player to connect afterwards sees "Waking up the game server…" for up
to a minute. After that, it's instant.

### Everything on one Node host

On Render, Railway, a VPS or cPanel's *Setup Node.js App*, run the server zip
with `npm install` and `npm start` (startup file `server.js`). The server serves
the website too, so there's nothing to configure. It listens on the `PORT`
environment variable and switches to `wss://` automatically on HTTPS. Behind
nginx, pass WebSocket upgrades through:

```nginx
location / {
    proxy_pass http://127.0.0.1:3000;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_set_header Host $host;
    proxy_read_timeout 3600s;
}
```

## Controls

| Action           | Keyboard            | Gamepad      |
| ---------------- | ------------------- | ------------ |
| Accelerate       | `W` / `↑`           | RT / A       |
| Brake / reverse  | `S` / `↓`           | LT / B       |
| Steer            | `A` `D` / `←` `→`   | Left stick   |
| Handbrake drift  | `Space`             | X            |
| Fire a turbo     | `Shift`             | RB / Y       |
| Reset car        | `R`                 |              |
| Camera view      | `C`                 |              |
| Zoom             | `-` `+` / mouse wheel, `0` resets |  |
| Mute             | `M`                 |              |

On phones and tablets, touch buttons appear on screen.

## Turbo capsules

Glowing ⚡ capsules are scattered around every track (yellow dots on the
minimap). Drive through one to add a turbo to your stock; you can carry up to
5. Press `Shift` to fire one: for 3 seconds your top speed is 1.5x and the car
gets an extra push. Collected capsules reappear somewhere nearby after 8
seconds. Bots collect and use turbos too. When your stock is full you leave
capsules for everyone else.

## Camera views

Pick a view in the lobby or press `C` during a race. Your choice only changes
your own screen and is remembered next time.

- **Classic**: top-down, north always up.
- **Chase**: rotates with your car so the road ahead is always up the screen.
- **Close-up**: zoomed in tight.
- **Wide**: zoomed out to see more of the track.

## How it works

```
server.js          HTTP + WebSocket server: rooms, race flow, lap counting, bots
bot.js             Bot driving AI
shared/tracks.js   Track layouts and geometry (used by server and browser)
shared/physics.js  Car physics and turbo (used by server and browser)
shared/turbo.js    Turbo capsule placement and pickup checks
public/            Browser client (index.html, style.css, config.js, js/)
scripts/package.mjs  Builds the Netlify and server upload zips
render.yaml        Render setup for the game server
```

- Each browser simulates its own car at a fixed 120 Hz, so steering has no network lag. It sends its position to the server about 30 times a second.
- The server is in charge of the race. It counts laps from those positions, simulates the bots with the same physics code, and broadcasts a snapshot of every car 20 times a second.
- Other cars are drawn about 100 ms behind real time and interpolated between snapshots, so they move smoothly.

## Adding a track

Add an entry to `TRACK_DEFS` in `shared/tracks.js`. A track is a list of
control points that a smooth closed spline passes through. The start/finish
line is placed at the first point, so put that point in the middle of a
straight. Keep corners gentle: the tightest radius should be at least about
150 px after scaling, and different parts of the track need to be at least
about 300 px apart so their barriers don't overlap.
