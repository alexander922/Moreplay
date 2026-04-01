/**
 * server/index.js
 *
 * Multiplayer relay server — no IPs exposed to clients.
 * Players use short room codes (e.g. "XK7R2Q") to find each other.
 *
 * Anti-DOS protections included:
 *   • Max concurrent connections per IP
 *   • Rate limit on room creation per IP
 *   • Max message size
 *   • Max players per room
 *   • Max total rooms
 */

'use strict';

const http    = require('http');
const crypto  = require('crypto');
const { WebSocketServer } = require('ws');
const { RoomManager }     = require('./RoomManager');

// ─── Configuration ────────────────────────────────────────────────────────────

const PORT                   = Number(process.env.PORT)   || 3000;
const MAX_CONN_PER_IP        = Number(process.env.MAX_CONN_PER_IP)   || 5;
const MAX_MSG_BYTES          = Number(process.env.MAX_MSG_BYTES)      || 4096;   // 4 KB
const RATE_WINDOW_MS         = Number(process.env.RATE_WINDOW_MS)     || 60_000; // 1 min
const RATE_MAX_CREATES       = Number(process.env.RATE_MAX_CREATES)   || 10;
const ROOM_MAX_PLAYERS_LIMIT = Number(process.env.ROOM_MAX_PLAYERS)   || 32;

// ─── State ────────────────────────────────────────────────────────────────────

const manager       = new RoomManager({ maxRooms: 1000 });
const ipConnections = new Map(); // ip → number
const ipCreateLog   = new Map(); // ip → number[] (timestamps)

// ─── HTTP server (health check) ───────────────────────────────────────────────

const httpServer = http.createServer((req, res) => {
  if (req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      status: 'ok',
      rooms:   manager.rooms.size,
      players: manager.playerRoom.size,
    }));
  } else {
    res.writeHead(404);
    res.end();
  }
});

// ─── WebSocket server ─────────────────────────────────────────────────────────

const wss = new WebSocketServer({ server: httpServer, maxPayload: MAX_MSG_BYTES });

// ─── Helpers ──────────────────────────────────────────────────────────────────

function getIp(req) {
  return (
    (req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'unknown')
      .split(',')[0].trim()
  );
}

function generateId() {
  return crypto.randomBytes(8).toString('hex');
}

/** Returns true if the action is within the rate limit window. */
function checkRateLimit(ip, map, max, windowMs) {
  const now  = Date.now();
  const hits = (map.get(ip) || []).filter(t => now - t < windowMs);
  if (hits.length >= max) return false;
  hits.push(now);
  map.set(ip, hits);
  return true;
}

/** Send a structured message to a single WebSocket. */
function send(ws, type, payload = {}) {
  if (ws.readyState === 1 /* OPEN */) {
    ws.send(JSON.stringify({ type, ...payload }));
  }
}

// ─── Connection handler ───────────────────────────────────────────────────────

wss.on('connection', (ws, req) => {
  const ip = getIp(req);

  // ── Anti-DOS: connection cap per IP ────────────────────────────────────────
  const connCount = (ipConnections.get(ip) || 0) + 1;
  if (connCount > MAX_CONN_PER_IP) {
    ws.close(1008, 'TOO_MANY_CONNECTIONS');
    return;
  }
  ipConnections.set(ip, connCount);

  // ── Assign a unique anonymous ID ───────────────────────────────────────────
  const playerId = generateId();
  ws.playerId = playerId;
  ws.ip = ip;

  send(ws, 'connected', { id: playerId });

  // ── Message handler ────────────────────────────────────────────────────────
  ws.on('message', (raw) => {
    // Basic sanity check
    if (raw.length > MAX_MSG_BYTES) return;

    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    const { type, payload = {} } = msg;
    if (typeof type !== 'string') return;

    switch (type) {

      // ── Create a new room ─────────────────────────────────────────────────
      case 'create_room': {
        if (!checkRateLimit(ip, ipCreateLog, RATE_MAX_CREATES, RATE_WINDOW_MS)) {
          return send(ws, 'error', {
            code: 'RATE_LIMITED',
            message: `Max ${RATE_MAX_CREATES} rooms per minute per IP`,
          });
        }

        // Leave any current room before creating a new one
        _handleLeave(ws, /* silent */ true);

        const maxPlayers = Math.min(
          Math.max(2, Number(payload.maxPlayers) || 8),
          ROOM_MAX_PLAYERS_LIMIT
        );

        const { room, error } = manager.createRoom(playerId, {
          maxPlayers,
          data: payload.data || {},
        });

        if (error) return send(ws, 'error', { code: error });

        // Host is automatically the first player in the room
        room.addPlayer(playerId, sanitizeName(payload.name), ws);
        manager.playerRoom.set(playerId, room.code);

        send(ws, 'room_created', {
          code:    room.code,
          players: room.getPlayerList(),
          data:    room.data,
        });
        break;
      }

      // ── Join an existing room ─────────────────────────────────────────────
      case 'join_room': {
        _handleLeave(ws, /* silent */ true);

        const code = String(payload.code || '').toUpperCase().trim();
        const { room, error } = manager.joinRoom(
          code,
          playerId,
          sanitizeName(payload.name),
          ws
        );

        if (error) return send(ws, 'error', { code: error });

        send(ws, 'room_joined', {
          code:    room.code,
          hostId:  room.hostId,
          players: room.getPlayerList(),
          data:    room.data,
        });

        // Notify everyone else in the room
        room.broadcast({
          type:    'player_joined',
          player:  { id: playerId, name: sanitizeName(payload.name) },
          players: room.getPlayerList(),
        }, playerId);
        break;
      }

      // ── Send a message (broadcast or direct) ──────────────────────────────
      case 'message': {
        const room = manager.getRoomByPlayer(playerId);
        if (!room) return send(ws, 'error', { code: 'NOT_IN_ROOM' });

        const outMsg = {
          type:  'message',
          from:  playerId,
          event: String(payload.event || 'data').slice(0, 64),
          data:  payload.data ?? null,
        };

        if (payload.to) {
          // Direct message to a specific player in the same room
          const target = room.players.get(String(payload.to));
          if (target && target.ws.readyState === 1) {
            target.ws.send(JSON.stringify(outMsg));
          }
        } else {
          // Broadcast to the whole room
          const excludeSelf = payload.includeSelf !== true ? playerId : null;
          room.broadcast(outMsg, excludeSelf);
        }
        break;
      }

      // ── Leave the current room ────────────────────────────────────────────
      case 'leave_room': {
        _handleLeave(ws, /* silent */ false);
        break;
      }

      // ── Lock / unlock the room (host only) ────────────────────────────────
      case 'lock_room': {
        const room = manager.getRoomByPlayer(playerId);
        if (!room || room.hostId !== playerId) return;
        room.locked = payload.locked !== false;
        room.broadcast({ type: 'room_locked', locked: room.locked });
        break;
      }

      // ── Kick a player (host only) ─────────────────────────────────────────
      case 'kick_player': {
        const room = manager.getRoomByPlayer(playerId);
        if (!room || room.hostId !== playerId) return;

        const targetId = String(payload.playerId || '');
        const target   = room.players.get(targetId);
        if (!target) return;

        send(target.ws, 'kicked', { reason: String(payload.reason || '') });
        _handleLeave(target.ws, /* silent */ false);
        break;
      }

      default:
        // Unknown message types are silently ignored
        break;
    }
  });

  // ── Cleanup on disconnect ──────────────────────────────────────────────────
  ws.on('close', () => {
    const count = (ipConnections.get(ip) || 1) - 1;
    if (count <= 0) ipConnections.delete(ip);
    else            ipConnections.set(ip, count);

    _handleLeave(ws, /* silent */ false);
  });

  ws.on('error', (err) => {
    console.error(`[ws] error for player ${playerId}:`, err.message);
  });
});

// ─── Leave helper ─────────────────────────────────────────────────────────────

/**
 * Remove the player from their room and notify the others.
 * @param {WebSocket} ws
 * @param {boolean}   silent - If true, do NOT send room_left to the leaving player
 */
function _handleLeave(ws, silent = false) {
  const result = manager.leaveRoom(ws.playerId);
  if (!result) return;

  if (!silent) send(ws, 'room_left', {});

  const { room, newHostId } = result;
  if (!room) return; // Room was destroyed (was empty)

  // Notify remaining players
  room.broadcast({
    type:      'player_left',
    playerId:  ws.playerId,
    players:   room.getPlayerList(),
    newHostId: newHostId || null,
  });

  // Tell the new host they've been promoted
  if (newHostId) {
    const newHost = room.players.get(newHostId);
    if (newHost) send(newHost.ws, 'host_migrated', { hostId: newHostId });
  }
}

// ─── Utils ────────────────────────────────────────────────────────────────────

function sanitizeName(raw) {
  return String(raw || 'Player').replace(/[<>"'&]/g, '').slice(0, 32).trim() || 'Player';
}

// ─── Start ────────────────────────────────────────────────────────────────────

httpServer.listen(PORT, () => {
  console.log(`🚀  Multiplayer server ready on ws://localhost:${PORT}`);
  console.log(`    Health check → http://localhost:${PORT}/health`);
});
