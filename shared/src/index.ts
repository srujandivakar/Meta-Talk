// ─────────────────────────────────────────────
//  SHARED TYPES  –  used by both client & server
//  Any change here will be flagged by TypeScript
//  everywhere it's used. No surprises.
// ─────────────────────────────────────────────

/**
 * A player that exists in a room.
 * Kept intentionally small for Phase 1.
 * We'll grow this as we add avatars, names, etc.
 */
export interface Player {
  id: string;        // Socket ID (unique per connection)
  x: number;         // World X position in pixels
  y: number;         // World Y position in pixels
  roomId: string;    // Which room they're in
  color: string;     // Temporary avatar color (until we have real avatars)
}

/**
 * Payload sent from client → server when a player moves.
 */
export interface MovePayload {
  x: number;
  y: number;
}

/**
 * All Socket.IO events in one place.
 * Using a const object (not enum) so values are available at runtime too.
 *
 * WHY: Hardcoded strings like "player:move" scattered across files
 * are a nightmare to refactor. One typo = silent bug. This fixes that.
 */
export const EVENTS = {
  // ── Movement ───────────────────────────────────────────────
  // Server → Client
  ROOM_STATE: "room:state",          // Full snapshot of everyone in room on join
  PLAYER_JOINED: "player:joined",    // Someone new joined
  PLAYER_LEFT: "player:left",        // Someone disconnected
  PLAYER_MOVED: "player:moved",      // A player's position updated

  // Client → Server
  PLAYER_MOVE: "player:move",        // "I want to move here"
  JOIN_ROOM: "join:room",            // "I want to join this room"

  // Server → joining client only
  // Sent right after JOIN_ROOM so the client knows its server-assigned
  // spawn position and can snap its own avatar to match, avoiding the
  // situation where all players Phaser-spawn at (800,600) and overlap.
  SELF_PLAYER: "self:player",

  // ── Voice call signaling ────────────────────────────────────
  // These events are all relayed by the server (it never processes them,
  // just forwards to the target player by socket ID).
  CALL_REQUEST: "call:request",      // A → server → B: "can we talk?"
  CALL_ACCEPT: "call:accept",        // B → server → A: "yes"
  CALL_DECLINE: "call:decline",      // B → server → A: "no"
  CALL_END: "call:end",              // either → server → other: hang up

  // ── WebRTC signaling (relayed by server, never stored) ──────
  // These carry the connection negotiation data between two browsers.
  // Once WebRTC connects, audio travels directly browser↔browser.
  WEBRTC_OFFER: "webrtc:offer",      // Caller sends SDP offer
  WEBRTC_ANSWER: "webrtc:answer",    // Callee responds with SDP answer
  WEBRTC_ICE: "webrtc:ice",          // ICE candidate exchange (NAT traversal info)
} as const;

// ─────────────────────────────────────────────────────────────────
//  CALL SIGNALING PAYLOADS
// ─────────────────────────────────────────────────────────────────

/** Sent by caller when requesting a voice call. */
export interface CallRequestPayload {
  to: string;   // target socket ID
}

/** Sent by callee to accept or decline. */
export interface CallResponsePayload {
  to: string;   // original caller's socket ID
}

/** WebRTC offer/answer payload — carries the SDP session description. */
export interface WebRtcSdpPayload {
  to: string;
  sdp: RTCSessionDescriptionInit;
}

/** WebRTC ICE candidate payload — carries NAT traversal info. */
export interface WebRtcIcePayload {
  to: string;
  candidate: RTCIceCandidateInit;
}
