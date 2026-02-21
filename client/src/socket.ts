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
// Connect to the same origin as the page (window.location.origin).
// In dev, Vite proxies /socket.io → http://localhost:3001, so the
// client never makes a cross-origin HTTP request. This also avoids
// "mixed content" errors when Vite is served over HTTPS (which is
// required on phones for getUserMedia / WebRTC to work).
export const socket: Socket = io({
  autoConnect: false,
  // Start with polling (goes through Vite's HTTP proxy reliably), then
  // upgrade to WebSocket once the connection is established.
  // WHY NOT websocket-only: Vite's HMR WebSocket server intercepts WS upgrades
  // before the proxy can forward them, so websocket-only connections silently
  // fail to deliver events. Polling bypasses this entirely.
  transports: ["polling", "websocket"],
});
