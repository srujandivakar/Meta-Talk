import { createRoot } from "react-dom/client";
import { App } from "./App";

// WHY no StrictMode?
// StrictMode intentionally double-invokes effects in dev to find bugs.
// That breaks games and WebSockets: each tab emits JOIN_ROOM twice,
// causing the server to broadcast PLAYER_JOINED twice to everyone else
// and Phaser to initialize twice per tab.
// For a traditional React app StrictMode is great — for a game, it isn't.
createRoot(document.getElementById("root")!).render(<App />);
