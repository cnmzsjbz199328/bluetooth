# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A LAN multiplayer "Fruit Ninja" (切西瓜) game. A phone acts as a gyroscope/accelerometer
controller; a desktop browser renders the game. A Node.js server relays sensor data between
them over WebSocket. Code comments and UI are in Chinese.

The hard problem this project solves: iOS only exposes `DeviceMotionEvent` over HTTPS, and
self-signed certs are painful to install on iPhone. The current solution routes phone traffic
through a **Cloudflare Tunnel** (auto-started by the server) so the phone gets real HTTPS/WSS
with zero cert setup. The self-signed-cert path (`generate-cert.js`, `/cert` download) is the
legacy fallback.

## Commands

- `npm start` (or `node server.js`) — start server on port 3000, auto-launch Cloudflare Tunnel
- `npm run cert` — regenerate self-signed certs into `cert/` (only needed for the fallback path)
- No build, no lint, no tests. Client JS is served raw from `public/`; there is no bundler.

To force the legacy local-cert HTTP/HTTPS mode instead of the tunnel: the server runs HTTPS if
`cert/cert.pem` + `cert/key.pem` exist, unless a `cert/.http-mode` marker file is present
(see `hasSSL` in [server.js](server.js)).

Requires `cloudflared.exe` in the project root (gitignored, ~54MB) or `cloudflared` on PATH.

## Architecture

Three roles connect over a single WebSocket server. Messages are JSON with a `type` field; the
server is a **pure relay** with no game logic — it routes by registered role:

- **Server** ([server.js](server.js)) — static file host + `WebSocketServer`. Tracks two client
  sets (`game`, `controller`) populated when a client sends `{type:'register', role}`. Routing in
  the `ws.on('message')` handler: `gyro`/`gesture` → broadcast to `game`; `feedback` → broadcast
  to `controller`; `ping` → `pong` reply. All game state lives in the browser, not here.

- **Game (desktop)** — [public/game.html](public/game.html) loads, in order, `physics.js`
  (entity classes: `Fruit`, `FruitHalf`, `JuiceParticle`, `SlashTrail`, `lineCircleIntersect`,
  all hung on `window.Physics`), `renderer.js` (`window.Renderer`, a Canvas2D draw layer), then
  `game.js` (the loop, WS handling, scoring). `game.js` connects WS to its own origin, registers
  as `game`, maps incoming `gyro` beta/gamma to a cursor position and `gesture` slashes to a
  line-segment collision test against fruit. Mouse + touch handlers simulate slashes for
  desktop/tablet debugging without a phone.

- **Controller (phone)** — sensor capture, calibration, and slash-gesture detection (accel
  magnitude over a sensitivity-scaled threshold with a cooldown). Sends `gyro` at ~60Hz and
  discrete `gesture` events. **There are two copies of this page and they are NOT auto-synced:**
  - [public/controller.html](public/controller.html) — served locally; reads `?ip`/`?port` URL params only.
  - [cloudflare-controller/index.html](cloudflare-controller/index.html) — the version deployed
    to Cloudflare Pages (`https://bluetooth-72w.pages.dev`, hardcoded as `CLOUDFLARE_URL` in
    server.js). Adds the `?ip_tunnel=<wss-url>` param the tunnel flow depends on.
  When changing controller behavior, update **both** files, and redeploy the `cloudflare-controller/`
  one to Pages for the tunnel flow to pick it up.

## Message protocol (client ⇄ server ⇄ client)

| type | direction | purpose |
|------|-----------|---------|
| `register` | client→server | declare `role: 'game'｜'controller'` |
| `gyro` | controller→game | raw orientation/accel (~60Hz), drives cursor |
| `gesture` | controller→game | `{gesture:'slash', angle, speed}` |
| `feedback` | game→controller | `{subtype:'score'｜'combo', ...}` for haptics/popups |
| `ping`/`pong` | controller↔server | latency measurement |
| `controller_connected` / `_disconnected`, `game_connected` / `_disconnected` | server→peer | presence notifications |

## Gotchas

- Port 3000 conflicts are common on restart; server prints a `taskkill /F /IM node.exe` hint.
- The deployed Pages controller URL is hardcoded — changing the Pages project means editing
  `CLOUDFLARE_URL` in server.js.
