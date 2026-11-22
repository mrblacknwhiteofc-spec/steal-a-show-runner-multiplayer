# Steal a Show Runner — multiplayer starter

This repository contains the game client and Node.js WebSocket server.

## Deploy the server on Render

1. In Render, choose **New + → Blueprint** (or create a Web Service).
2. Connect this repository: `mrblacknwhiteofc-spec/steal-a-show-runner-multiplayer`.
3. Render reads `render.yaml`; the service uses `npm install` and `npm start`.
4. After deployment, open the service URL and confirm `/health` returns JSON with `ok: true`.
5. Copy the secure WebSocket address: `wss://YOUR-SERVICE.onrender.com`.
6. In `index.html`, replace `ws://localhost:3000` in `MULTIPLAYER_SERVER` with that `wss://` address, then upload that updated HTML to GameJolt.

## Current multiplayer foundation

- Public matchmaking and private six-character room codes.
- Up to 8 connected players per room.
- Real-time position/rotation updates and remote player avatars.
- Player join/leave notifications.
- Health endpoint at `/health`.

## Not implemented yet

This is an initial multiplayer foundation, not a complete authoritative online game. Bot replacement, secure accounts, cloud saves, trading, global leaderboards, runner ownership, purchases, theft/combat, and shared world events still need server-side implementation. Existing game progress remains browser-local. The server uses guest display names and does not store passwords.
