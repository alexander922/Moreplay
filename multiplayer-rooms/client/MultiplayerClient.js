/**
 * MultiplayerClient.js
 *
 * Lightweight client for the multiplayer-rooms relay server.
 * Works in the browser (via <script> tag or ES module) and in Node.js.
 *
 * Usage (browser):
 *   const client = new MultiplayerClient('ws://localhost:3000');
 *   await client.connect();
 *   client.createRoom('Alice');
 *   client.on('room_created', ({ code }) => console.log('Code:', code));
 *
 * Usage (Node.js):
 *   const { MultiplayerClient } = require('./client/MultiplayerClient');
 *   // same API as above, but pass a 'ws' WebSocket implementation:
 *   const { MultiplayerClient } = require('./client/MultiplayerClient');
 *   const client = new MultiplayerClient('ws://localhost:3000', { WebSocket: require('ws') });
 */

'use strict';

class MultiplayerClient {
  /**
   * @param {string} serverUrl - WebSocket server URL (e.g. 'ws://localhost:3000')
   * @param {object} [options]
   * @param {function} [options.WebSocket] - Custom WebSocket class (for Node.js, pass `require('ws')`)
   */
  constructor(serverUrl, options = {}) {
    this._url       = serverUrl;
    this._WS        = options.WebSocket || (typeof WebSocket !== 'undefined' ? WebSocket : null);
    this._ws        = null;
    this._listeners = {}; // event → callback[]

    /** Your anonymous player ID, set by the server on connect. */
    this.id       = null;
    /** Current room code, or null if not in a room. */
    this.roomCode = null;
    /** Array of { id, name, isHost } for all players in the room. */
    this.players  = [];
    /** Whether this client is the room host. */
    this.isHost   = false;
  }

  // ─── Connection ─────────────────────────────────────────────────────────────

  /**
   * Connect to the server.
   * @returns {Promise<MultiplayerClient>} Resolves when the connection is confirmed.
   */
  connect() {
    if (!this._WS) throw new Error('[MultiplayerClient] No WebSocket implementation found. Pass one via options.WebSocket');

    return new Promise((resolve, reject) => {
      this._ws = new this._WS(this._url);

      this._ws.onopen = () => { /* Wait for the 'connected' message from server */ };

      this._ws.onmessage = (event) => {
        let msg;
        try { msg = JSON.parse(event.data); } catch { return; }
        this._handleMessage(msg);
        if (msg.type === 'connected') resolve(this);
      };

      this._ws.onerror = (err) => {
        this._emit('error', { code: 'CONNECTION_ERROR', raw: err });
        reject(err);
      };

      this._ws.onclose = (event) => {
        this._emit('disconnected', { code: event.code, reason: event.reason });
      };
    });
  }

  /** Close the WebSocket connection. */
  disconnect() {
    this._ws?.close();
  }

  // ─── Room actions ────────────────────────────────────────────────────────────

  /**
   * Create a new room. Listen for the 'room_created' event to get the code.
   * @param {string} name           - Your display name
   * @param {object} [options]
   * @param {number} [options.maxPlayers=8] - Max players allowed in the room
   * @param {object} [options.data={}]      - Custom metadata stored with the room
   */
  createRoom(name, options = {}) {
    this._send('create_room', { name, ...options });
    return this;
  }

  /**
   * Join an existing room by code.
   * @param {string} code - Room code (e.g. 'XK7R2Q'), case-insensitive
   * @param {string} name - Your display name
   */
  joinRoom(code, name) {
    this._send('join_room', { code, name });
    return this;
  }

  /** Leave the current room. */
  leave() {
    this._send('leave_room');
    return this;
  }

  // ─── Messaging ───────────────────────────────────────────────────────────────

  /**
   * Broadcast a named event + data to everyone in the room.
   * @param {string} event - Your event name (e.g. 'move', 'chat', 'score')
   * @param {*}      data  - Any JSON-serialisable value
   */
  broadcast(event, data) {
    this._send('message', { event, data });
    return this;
  }

  /**
   * Send a named event to a specific player only.
   * @param {string} playerId - Target player's ID
   * @param {string} event    - Your event name
   * @param {*}      data     - Any JSON-serialisable value
   */
  sendTo(playerId, event, data) {
    this._send('message', { event, data, to: playerId });
    return this;
  }

  // ─── Host-only actions ───────────────────────────────────────────────────────

  /**
   * Lock or unlock the room to prevent new players from joining. (Host only)
   * @param {boolean} [locked=true]
   */
  lockRoom(locked = true) {
    this._send('lock_room', { locked });
    return this;
  }

  /**
   * Kick a player from the room. (Host only)
   * @param {string} playerId - ID of the player to kick
   * @param {string} [reason=''] - Optional reason string shown to the kicked player
   */
  kick(playerId, reason = '') {
    this._send('kick_player', { playerId, reason });
    return this;
  }

  // ─── Events ──────────────────────────────────────────────────────────────────

  /**
   * Register an event listener.
   *
   * Core events:
   *   connected       { id }
   *   disconnected    { code, reason }
   *   error           { code, message? }
   *   room_created    { code, players, data }
   *   room_joined     { code, hostId, players, data }
   *   room_left       {}
   *   player_joined   { player, players }
   *   player_left     { playerId, players, newHostId }
   *   host_migrated   { hostId }
   *   room_locked     { locked }
   *   kicked          { reason }
   *
   * Message events:
   *   message              { from, event, data }   — all incoming messages
   *   message:<eventName>  { from, event, data }   — e.g. 'message:move'
   *
   * @param {string}   event
   * @param {function} callback
   */
  on(event, callback) {
    if (!this._listeners[event]) this._listeners[event] = [];
    this._listeners[event].push(callback);
    return this;
  }

  /** Remove a previously registered listener. */
  off(event, callback) {
    if (!this._listeners[event]) return this;
    this._listeners[event] = this._listeners[event].filter(fn => fn !== callback);
    return this;
  }

  /** Remove ALL listeners for a given event. */
  offAll(event) {
    delete this._listeners[event];
    return this;
  }

  // ─── Internal ────────────────────────────────────────────────────────────────

  _send(type, payload = {}) {
    const ws = this._ws;
    if (ws && ws.readyState === 1 /* OPEN */) {
      ws.send(JSON.stringify({ type, payload }));
    } else {
      console.warn(`[MultiplayerClient] Cannot send '${type}': not connected`);
    }
  }

  _emit(event, data) {
    const handlers = this._listeners[event];
    if (handlers) handlers.forEach(fn => fn(data));
  }

  _handleMessage(msg) {
    switch (msg.type) {

      case 'connected':
        this.id = msg.id;
        this._emit('connected', { id: msg.id });
        break;

      case 'room_created':
        this.roomCode = msg.code;
        this.players  = msg.players;
        this.isHost   = true;
        this._emit('room_created', msg);
        break;

      case 'room_joined':
        this.roomCode = msg.code;
        this.players  = msg.players;
        this.isHost   = msg.hostId === this.id;
        this._emit('room_joined', msg);
        break;

      case 'room_left':
        this.roomCode = null;
        this.players  = [];
        this.isHost   = false;
        this._emit('room_left', {});
        break;

      case 'player_joined':
        this.players = msg.players;
        this._emit('player_joined', msg);
        break;

      case 'player_left':
        this.players = msg.players;
        if (msg.newHostId === this.id) this.isHost = true;
        this._emit('player_left', msg);
        break;

      case 'host_migrated':
        this.isHost = true;
        this._emit('host_migrated', msg);
        break;

      case 'message':
        this._emit('message', msg);
        if (msg.event) this._emit(`message:${msg.event}`, msg);
        break;

      case 'room_locked':
        this._emit('room_locked', msg);
        break;

      case 'kicked':
        this.roomCode = null;
        this.players  = [];
        this.isHost   = false;
        this._emit('kicked', msg);
        break;

      case 'error':
        this._emit('error', msg);
        console.warn('[MultiplayerClient] Server error:', msg.code, msg.message || '');
        break;

      default:
        // Forward unknown server-pushed events as-is
        this._emit(msg.type, msg);
    }
  }
}

// Support both CommonJS and ES modules
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { MultiplayerClient };
}
