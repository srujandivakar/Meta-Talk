import { io, Socket } from "socket.io-client";

// ─────────────────────────────────────────────────────────────────
//  SOCKET SINGLETON
//
//  WHY a singleton?
//  If we created a new socket in every component or every scene,
//  we'd accidentally open multiple WebSocket connections.
//  One connection, referenced everywhere — this is the pattern.
//
//  autoConnect: false means we connect only when we're ready
//  (after the user enters a room), not immediately on page load.
// ─────────────────────────────────────────────────────────────────
// In production, connect to VITE_SERVER_URL (backend).
// In dev, Vite proxies /socket.io → http://localhost:3001
const SERVER_URL = import.meta.env.VITE_SERVER_URL || window.location.origin;

export const socket: Socket = io(SERVER_URL, {
  autoConnect: false,
  // Start with polling (goes through Vite's HTTP proxy reliably), then
  // upgrade to WebSocket once the connection is established.
  transports: ["polling", "websocket"],
});
