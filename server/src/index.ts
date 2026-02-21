import express from "express";
import { createServer } from "http";
import { Server } from "socket.io";
import cors from "cors";
import {
  EVENTS, Player, MovePayload,
  CallRequestPayload, CallResponsePayload,
  WebRtcSdpPayload, WebRtcIcePayload,
} from "@mping/shared";

// ─────────────────────────────────────────────────────────────────
//  SERVER SETUP
//
//  WHY Express + http.createServer + Socket.IO separately?
//  Socket.IO needs to attach to an HTTP server, not an Express app.
//  This pattern is the recommended way to run both on one port.
// ─────────────────────────────────────────────────────────────────
const app = express();
const httpServer = createServer(app);

// Allow any origin in dev — the Vite proxy proxies requests from the phone
// through Vite's dev server, so the origin may be a LAN IP over HTTPS.
// In production this would be your real domain only.
const CORS_ORIGIN = process.env.NODE_ENV === "production"
  ? process.env.CLIENT_URL ?? "https://your-app.vercel.app"
  : true; // true = reflect the request's Origin header back, allowing everything in dev

const io = new Server(httpServer, {
  cors: {
    origin: CORS_ORIGIN,
    methods: ["GET", "POST"],
  },
});

app.use(cors({ origin: CORS_ORIGIN }));
app.use(express.json());

// Health check endpoint — useful for deployment platforms to verify the
// server is alive (Render, Railway, etc. use this before routing traffic).
app.get("/health", (_req, res) => {
  res.json({ status: "ok", uptime: process.uptime() });
});

// ─────────────────────────────────────────────────────────────────
//  IN-MEMORY ROOM STATE
//
//  For Phase 1 we store everything in memory.
//  PRO: Zero setup, instant, no DB needed.
//  CON: State is lost on server restart, can't scale to multiple servers.
//  We'll move this to a DB in a later phase when we need persistence.
//
//  Structure: { roomId → { playerId → Player } }
// ─────────────────────────────────────────────────────────────────
const rooms = new Map<string, Map<string, Player>>();

/** Returns the player map for a room, creating it if it doesn't exist. */
function getOrCreateRoom(roomId: string): Map<string, Player> {
  if (!rooms.has(roomId)) {
    rooms.set(roomId, new Map());
  }
  return rooms.get(roomId)!;
}

/** Assign a deterministic color from a small palette based on player count. */
const COLORS = [
  "#FF6B6B", "#4ECDC4", "#45B7D1", "#96CEB4",
  "#FFEAA7", "#DDA0DD", "#98D8C8", "#F7DC6F",
];
function pickColor(index: number): string {
  return COLORS[index % COLORS.length];
}

// ─────────────────────────────────────────────────────────────────
//  SOCKET.IO EVENT HANDLING
// ─────────────────────────────────────────────────────────────────
io.on("connection", (socket) => {
  console.log(`[+] Player connected: ${socket.id}`);

  let currentRoomId: string | null = null;

  // ── JOIN ROOM ─────────────────────────────────────────────────
  socket.on(EVENTS.JOIN_ROOM, (roomId: string) => {
    currentRoomId = roomId;
    const room = getOrCreateRoom(roomId);

    // Guard: if this socket is already tracked in the room (e.g. hot-reload
    // or any double-emit), preserve their position and color and do NOT
    // broadcast PLAYER_JOINED to others — they already know this player.
    // Without this, every extra JOIN_ROOM causes everyone else's count
    // to increment and duplicates to appear.
    const isRejoin = room.has(socket.id);
    const existing = room.get(socket.id);

    // Spawn near the world centre (800, 600) with a small random spread.
    // WHY 800/600? That's WORLD_W/2 + WORLD_H/2 — the same spot Phaser
    // initialises every client's own avatar. Keeping these in sync means
    // when the server sends ROOM_STATE with existing players, their
    // positions are in the same area of the world as newcomers and are
    // immediately visible without anyone having to walk far.
    const newPlayer: Player = {
      id: socket.id,
      x: isRejoin ? existing!.x : 800 + (Math.random() - 0.5) * 160,
      y: isRejoin ? existing!.y : 600 + (Math.random() - 0.5) * 160,
      roomId,
      color: isRejoin ? existing!.color : pickColor(room.size),
    };

    room.set(socket.id, newPlayer);
    socket.join(roomId);

    // Always send full room state so the (re)joining client renders everyone
    const existingPlayers = Array.from(room.values()).filter(p => p.id !== socket.id);
    socket.emit(EVENTS.ROOM_STATE, existingPlayers);
    console.log(`[D] ROOM_STATE → ${socket.id} with ${existingPlayers.length} players:`,
      existingPlayers.map(p => `${p.id.slice(0,6)}@(${Math.round(p.x)},${Math.round(p.y)})`))

    // Send the joining player their own data so the client can snap its
    // avatar to the server-assigned spawn position instead of defaulting
    // to the hard-coded center and then jumping on the first PLAYER_MOVE.
    socket.emit(EVENTS.SELF_PLAYER, newPlayer);

    // Only announce to others if this is a brand-new connection
    if (!isRejoin) {
      socket.to(roomId).emit(EVENTS.PLAYER_JOINED, newPlayer);
    }

    console.log(`[R] ${socket.id} ${isRejoin ? "re-synced" : "joined"} room "${roomId}" (${room.size} players)`);
  });

  // ── PLAYER MOVE ───────────────────────────────────────────────
  // Client sends their new intended position; server rebroadcasts to others.
  //
  // NOTE: In a production game you'd validate positions server-side to
  // prevent cheating. For Phase 1 we trust the client — we'll add
  // server-side validation in a later phase.
  socket.on(EVENTS.PLAYER_MOVE, (payload: MovePayload) => {
    if (!currentRoomId) return;

    const room = rooms.get(currentRoomId);
    if (!room) return;

    const player = room.get(socket.id);
    if (!player) return;

    // Update stored position
    player.x = payload.x;
    player.y = payload.y;

    // Broadcast the update to everyone in the room EXCEPT the sender.
    // The sender already knows their own position — no need to echo it back.
    socket.to(currentRoomId).emit(EVENTS.PLAYER_MOVED, {
      id: socket.id,
      x: payload.x,
      y: payload.y,
    });
  });

  // ── CALL + WEBRTC SIGNALING RELAY ─────────────────────────────
  //
  // The server is intentionally "dumb" here — it just forwards these
  // messages to the target player by socket ID.
  //
  // WHY not process them server-side?
  // WebRTC signaling (offer/answer/ICE) is negotiated directly between
  // two browsers. The server only acts as a post office during setup.
  // Once the WebRTC connection is established, audio goes P2P — zero
  // server bandwidth cost.
  //
  // Each handler follows the same pattern:
  //   1. Receive {to, ...data} from sender
  //   2. Forward {from: socket.id, ...data} to the target socket
  //   3. If target doesn't exist, silently ignore (they disconnected)

  const relay = (
    event: string,
    payload: { to: string },
    extra?: Record<string, unknown>,
  ) => {
    socket.to(payload.to).emit(event, { from: socket.id, ...payload, ...extra });
  };

  socket.on(EVENTS.CALL_REQUEST, (p: CallRequestPayload) =>
    relay(EVENTS.CALL_REQUEST, p));

  socket.on(EVENTS.CALL_ACCEPT, (p: CallResponsePayload) =>
    relay(EVENTS.CALL_ACCEPT, p));

  socket.on(EVENTS.CALL_DECLINE, (p: CallResponsePayload) =>
    relay(EVENTS.CALL_DECLINE, p));

  socket.on(EVENTS.CALL_END, (p: { to: string }) =>
    relay(EVENTS.CALL_END, p));

  socket.on(EVENTS.WEBRTC_OFFER, (p: WebRtcSdpPayload) =>
    relay(EVENTS.WEBRTC_OFFER, p));

  socket.on(EVENTS.WEBRTC_ANSWER, (p: WebRtcSdpPayload) =>
    relay(EVENTS.WEBRTC_ANSWER, p));

  socket.on(EVENTS.WEBRTC_ICE, (p: WebRtcIcePayload) =>
    relay(EVENTS.WEBRTC_ICE, p));

  // ── DISCONNECT ────────────────────────────────────────────────
  socket.on("disconnect", () => {
    console.log(`[-] Player disconnected: ${socket.id}`);

    if (!currentRoomId) return;

    const room = rooms.get(currentRoomId);
    if (!room) return;

    // Remove from room
    room.delete(socket.id);

    // Clean up empty rooms to prevent memory leaks
    if (room.size === 0) {
      rooms.delete(currentRoomId);
      console.log(`[R] Room "${currentRoomId}" is now empty, removed.`);
    }

    // Tell remaining players someone left
    io.to(currentRoomId).emit(EVENTS.PLAYER_LEFT, socket.id);
  });
});

// ─────────────────────────────────────────────────────────────────
//  START
// ─────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3001;
httpServer.listen(PORT, () => {
  console.log(`\n🚀 mping server running on http://localhost:${PORT}`);
  console.log(`   Health: http://localhost:${PORT}/health\n`);
});
