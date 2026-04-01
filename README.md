<div align="center">

```
 __  __                    _
|  \/  | ___  _ __ ___ _ __ | | __ _ _   _
| |\/| |/ _ \| '__/ _ \ '_ \| |/ _` | | | |
| |  | | (_) | | |  __/ |_) | | (_| | |_| |
|_|  |_|\___/|_|  \___| .__/|_|\__,_|\__, |
                       |_|            |___/
```

**Drop-in multiplayer relay for the web.**  
Room codes. No IPs. No config. Just play.

[![License: MIT](https://img.shields.io/badge/License-MIT-6c63ff.svg)](LICENSE)
[![Node.js](https://img.shields.io/badge/Node.js-%3E%3D18-339933?logo=node.js&logoColor=white)](https://nodejs.org)
[![WebSocket](https://img.shields.io/badge/Transport-WebSocket-00d4aa)](https://developer.mozilla.org/en-US/docs/Web/API/WebSockets_API)
[![PRs Welcome](https://img.shields.io/badge/PRs-welcome-brightgreen)](CONTRIBUTING.md)

</div>

---

## What is Moreplay?

Moreplay is a **WebSocket relay server** that lets players find each other using short, human-readable room codes — like `XK7R2Q` — inspired by how Unity Relay works.

Players never see each other's IP addresses. There's no peer-to-peer, no NAT traversal, no port forwarding. One person creates a room, shares a 6-character code, and everyone else joins. That's it.

It's designed to be **easy to drop into any web project** — games, collaborative tools, quizzes, whiteboards — anything that needs real-time communication between multiple users.

---

## How it works

```
Player A                  Server                  Player B
   |                        |                        |
   |── create_room ────────>|                        |
   |<─ code: "XK7R2Q" ──────|                        |
   |                        |<────── join "XK7R2Q" ──|
   |<─ player_joined ───────|──── room_joined ──────>|
   |                        |                        |
   |── broadcast("move") ──>|──── message ──────────>|
```

No IPs cross the wire. The server is a pure relay.

---

## Features

- 🔑 &nbsp;**Room codes** — short, readable, unambiguous (no `0/O` or `1/I` mix-ups)
- 🛡️ &nbsp;**Anti-DOS built-in** — connection caps, rate limits, and message size limits out of the box
- 👑 &nbsp;**Host migration** — if the host disconnects, the next player takes over automatically
- 🔒 &nbsp;**Lock rooms** — prevent new players from joining mid-game
- 🥾 &nbsp;**Kick players** — host can remove players with an optional reason
- 📨 &nbsp;**Direct messages** — send to one specific player instead of the whole room
- 🌐 &nbsp;**Universal client** — same API in browser and Node.js
- 📦 &nbsp;**One dependency** — only [`ws`](https://github.com/websockets/ws), nothing else

---

## Quick Start

```bash
git clone https://github.com/YOUR_USERNAME/moreplay
cd moreplay
npm install
npm start
```

Then open `example/index.html` in two browser tabs, create a room in one, paste the code into the other. Full working demo included.

---

## Project Structure

```
moreplay/
├── server/
│   ├── index.js              ← WebSocket server + anti-DOS logic
│   └── RoomManager.js        ← room and player state
├── client/
│   └── MultiplayerClient.js  ← client library (browser + Node.js)
└── example/
    └── index.html            ← working chat room demo
```

---

## Deploying

Moreplay is a plain Node.js process — it runs anywhere.

| Platform | How |
|---|---|
| **Railway** | Connect repo → deploy (auto-detects `npm start`) |
| **Render** | New Web Service → connect repo → done |
| **VPS** | `pm2 start server/index.js --name moreplay` |

A `/health` HTTP endpoint is included for uptime monitoring.

---

## Configuration

All settings are environment variables — no config files needed.

| Variable | Default | Description |
|---|---|---|
| `PORT` | `3000` | Server port |
| `MAX_CONN_PER_IP` | `5` | Max simultaneous connections per IP |
| `MAX_MSG_BYTES` | `4096` | Max message size |
| `RATE_MAX_CREATES` | `10` | Max rooms created per IP per minute |
| `ROOM_MAX_PLAYERS` | `32` | Hard player cap per room |

---

## Custom clients

The wire protocol is plain JSON over WebSocket, so you can write a client in any language — Python, Godot (GDScript), Unity (C#), Rust, etc. The full message format is documented in the [wiki](../../wiki).

---

## Contributing

PRs are welcome! Ideas if you want to help:

- 🧪 Write tests (Jest + `ws` mock)
- 🔌 Build a client wrapper for Godot, Unity or Python
- 🔐 Add optional room passwords
- 📊 Add a `/metrics` endpoint (Prometheus-style)

Please keep PRs focused — one thing at a time.

---

## License

[MIT](LICENSE) — free to use, modify and distribute.  
Built with ❤️ and one npm package.
