/**
 * RoomManager.js
 * Manages all active rooms and player-to-room mappings.
 */

'use strict';

const crypto = require('crypto');

// Unambiguous characters (no 0/O, 1/I/L, 5/S)
const CODE_CHARS = 'ABCDEFGHJKMNPQRTUVWXYZ2346789';

class Room {
  /**
   * @param {string} code       - Unique room code
   * @param {string} hostId     - Player ID of the host
   * @param {object} options
   * @param {number} options.maxPlayers - Max players allowed (default 8)
   * @param {object} options.data       - Custom metadata attached to the room
   */
  constructor(code, hostId, options = {}) {
    this.code       = code;
    this.hostId     = hostId;
    this.maxPlayers = Math.max(2, Math.min(options.maxPlayers || 8, 32));
    this.data       = options.data || {};
    this.players    = new Map(); // playerId → { id, name, ws }
    this.createdAt  = Date.now();
    this.locked     = false;
  }

  get size()   { return this.players.size; }
  isFull()     { return this.players.size >= this.maxPlayers; }
  hasPlayer(id){ return this.players.has(id); }

  addPlayer(id, name, ws) {
    this.players.set(id, { id, name, ws });
  }

  removePlayer(id) {
    this.players.delete(id);
  }

  /**
   * Send a JSON message to every connected player.
   * @param {object} msg         - Object to serialize
   * @param {string} [excludeId] - Optional player ID to skip
   */
  broadcast(msg, excludeId = null) {
    const raw = JSON.stringify(msg);
    for (const [id, player] of this.players) {
      if (id !== excludeId && player.ws.readyState === 1 /* OPEN */) {
        player.ws.send(raw);
      }
    }
  }

  /** Returns a safe, serialisable player list. */
  getPlayerList() {
    return [...this.players.values()].map(({ id, name }) => ({
      id,
      name,
      isHost: id === this.hostId,
    }));
  }
}


class RoomManager {
  /**
   * @param {object} options
   * @param {number} options.maxRooms   - Max concurrent rooms (default 1000)
   * @param {number} options.codeLength - Length of room codes (default 6)
   */
  constructor(options = {}) {
    this.rooms       = new Map(); // code  → Room
    this.playerRoom  = new Map(); // playerId → code
    this.maxRooms    = options.maxRooms   || 1000;
    this.codeLength  = options.codeLength || 6;
  }

  /** Generate a unique, human-readable room code. */
  _generateCode() {
    let code;
    do {
      code = Array.from({ length: this.codeLength }, () =>
        CODE_CHARS[crypto.randomInt(0, CODE_CHARS.length)]
      ).join('');
    } while (this.rooms.has(code));
    return code;
  }

  /**
   * Create a new room.
   * @returns {{ room: Room } | { error: string }}
   */
  createRoom(hostId, options = {}) {
    if (this.rooms.size >= this.maxRooms) return { error: 'SERVER_FULL' };

    const code = this._generateCode();
    const room = new Room(code, hostId, options);
    this.rooms.set(code, room);
    return { room };
  }

  /**
   * Add a player to an existing room.
   * @returns {{ room: Room } | { error: string }}
   */
  joinRoom(code, playerId, name, ws) {
    const room = this.rooms.get(code);
    if (!room)        return { error: 'ROOM_NOT_FOUND' };
    if (room.isFull()) return { error: 'ROOM_FULL' };
    if (room.locked)  return { error: 'ROOM_LOCKED' };

    room.addPlayer(playerId, name, ws);
    this.playerRoom.set(playerId, code);
    return { room };
  }

  /**
   * Remove a player from their current room.
   * Destroys the room if empty, or migrates host if needed.
   * @returns {{ room: Room|null, code: string, newHostId: string|null } | null}
   */
  leaveRoom(playerId) {
    const code = this.playerRoom.get(playerId);
    if (!code) return null;

    const room = this.rooms.get(code);
    if (!room) return null;

    room.removePlayer(playerId);
    this.playerRoom.delete(playerId);

    // Room is now empty → destroy it
    if (room.size === 0) {
      this.rooms.delete(code);
      return { room: null, code, newHostId: null };
    }

    // Host left → pick the next player as host
    let newHostId = null;
    if (room.hostId === playerId) {
      newHostId = room.players.keys().next().value;
      room.hostId = newHostId;
    }

    return { room, code, newHostId };
  }

  /** Returns the Room a player is currently in, or undefined. */
  getRoomByPlayer(playerId) {
    const code = this.playerRoom.get(playerId);
    return code ? this.rooms.get(code) : undefined;
  }
}

module.exports = { RoomManager, Room };
