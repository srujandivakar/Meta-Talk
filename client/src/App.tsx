import { useState, useEffect, useCallback } from "react";
import { PhaserGame } from "./game/PhaserGame";
import { socket } from "./socket";
import { EVENTS } from "@mping/shared";
import { voiceChat, CallState } from "./voice/VoiceChat";
import { CallOverlay } from "./components/CallOverlay";
import "./App.css";

type AppState = "lobby" | "connecting" | "in-game";

export function App() {
  const [appState, setAppState] = useState<AppState>("lobby");
  const [roomInput, setRoomInput] = useState("town-square");
  const [currentRoom, setCurrentRoom] = useState("");
  const [playerCount, setPlayerCount] = useState(0);
  const [isConnected, setIsConnected] = useState(false);

  // ── VOICE CALL STATE ─────────────────────────────────────────
  const [callState, setCallState] = useState<CallState>("idle");
  const [callPeerId, setCallPeerId] = useState<string | null>(null);
  const [nearbyId, setNearbyId] = useState<string | null>(null);
  const [isMuted, setIsMuted] = useState(false);
  const [callError, setCallError] = useState<string | null>(null);

  // ── SOCKET LIFECYCLE ─────────────────────────────────────────
  useEffect(() => {
    voiceChat.init({
      onStateChange: (state) => {
        setCallState(state);
        if (state === "idle") {
          setCallPeerId(null);
          setIsMuted(false);
        }
      },
      onError: (msg) => setCallError(msg),
    });

    // Named refs so cleanup removes ONLY these handlers, not WorldScene's
    const onConnect    = () => setIsConnected(true);
    const onDisconnect = () => { setIsConnected(false); setAppState("lobby"); voiceChat.endCall(); };
    const onRoomState  = (players: {id:string}[]) => setPlayerCount(players.length + 1);
    const onJoined     = () => setPlayerCount((c) => c + 1);
    const onLeft       = () => setPlayerCount((c) => Math.max(1, c - 1));

    socket.on("connect",            onConnect);
    socket.on("disconnect",         onDisconnect);
    socket.on(EVENTS.ROOM_STATE,    onRoomState);
    socket.on(EVENTS.PLAYER_JOINED, onJoined);
    socket.on(EVENTS.PLAYER_LEFT,   onLeft);

    // ── Incoming call request ────────────────────────────────
    socket.on(EVENTS.CALL_REQUEST, (payload: { from: string }) => {
      // Use voiceChat.getState() not React's callState — the effect
      // closure captures the initial value, not the current one.
      if (voiceChat.getState() !== "idle") {
        socket.emit(EVENTS.CALL_DECLINE, { to: payload.from });
        return;
      }
      voiceChat.markReceiving(payload.from);
      setCallPeerId(payload.from);
      // The WEBRTC_OFFER will arrive shortly after CALL_REQUEST.
      // VoiceChat._pendingOffer stores it.
    });

    // ── Caller: their request was declined ──────────────────
    socket.on(EVENTS.CALL_DECLINE, () => {
      voiceChat.endCall();
      setCallError("They declined the call.");
    });

    // ── Caller: they accepted, initiate WebRTC ───────────────
    // When callee accepts, caller sends the WebRTC offer.
    // This is handled inside VoiceChat via WEBRTC_OFFER socket listener.
    socket.on(EVENTS.CALL_ACCEPT, async (payload: { from: string }) => {
      // Callee has accepted — now we (the caller) negotiate WebRTC.
      // voiceChat.initiateCall() was already called, it's waiting.
      // The WEBRTC_ANSWER will come from the callee and is handled in VoiceChat.
      void payload; // caller side continues via VoiceChat socket listeners
    });

    return () => {
      // Remove ONLY these specific handler refs — WorldScene's handlers
      // for the same events are untouched.
      socket.off("connect",            onConnect);
      socket.off("disconnect",         onDisconnect);
      socket.off(EVENTS.ROOM_STATE,    onRoomState);
      socket.off(EVENTS.PLAYER_JOINED, onJoined);
      socket.off(EVENTS.PLAYER_LEFT,   onLeft);
      socket.off(EVENTS.CALL_REQUEST);
      socket.off(EVENTS.CALL_DECLINE);
      socket.off(EVENTS.CALL_ACCEPT);
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // ── PROXIMITY CALLBACKS (passed to Phaser) ───────────────────
  // useCallback prevents new function references on every render,
  // which would otherwise cause PhaserGame to re-mount unnecessarily.
  const handleNearbyChange = useCallback((id: string | null) => {
    setNearbyId(id);
  }, []);

  // User pressed T or clicked the Talk button → send call request
  const handleTalkClicked = useCallback((targetId: string) => {
    if (callState !== "idle") return;
    setCallPeerId(targetId);
    socket.emit(EVENTS.CALL_REQUEST, { to: targetId });
    voiceChat.initiateCall(targetId);
  }, [callState]);

  // ── CALL CONTROL HANDLERS ────────────────────────────────────
  const handleAccept = async () => {
    const offer = voiceChat._pendingOffer;
    if (!offer || !callPeerId) return;
    socket.emit(EVENTS.CALL_ACCEPT, { to: callPeerId });
    await voiceChat.acceptCall(callPeerId, offer.sdp);
  };

  const handleDecline = () => {
    if (callPeerId) socket.emit(EVENTS.CALL_DECLINE, { to: callPeerId });
    voiceChat.endCall();
  };

  const handleHangUp = () => {
    voiceChat.endCall();
    setCallError(null);
  };

  const handleToggleMute = () => {
    setIsMuted((prev) => {
      const next = !prev;
      voiceChat.setMuted(next);
      return next;
    });
  };

  // ── JOIN / LEAVE ─────────────────────────────────────────────
  const handleJoin = () => {
    const roomId = roomInput.trim().toLowerCase().replace(/\s+/g, "-");
    if (!roomId) return;
    setAppState("connecting");
    const doEnter = () => {
      setNearbyId(null); // clear any stale proximity state from previous session
      setCurrentRoom(roomId);
      setAppState("in-game");
    };
    if (socket.connected) doEnter();
    else { socket.connect(); socket.once("connect", doEnter); }
  };

  const handleLeave = () => {
    voiceChat.endCall();
    socket.disconnect();
    setAppState("lobby");
    setCurrentRoom("");
    setPlayerCount(0);
    setNearbyId(null);
  };

  // ── RENDER ────────────────────────────────────────────────────
  if (appState === "lobby" || appState === "connecting") {
    return (
      <div className="lobby">
        <div className="lobby-card">
          <div className="lobby-logo">mping</div>
          <p className="lobby-tagline">A world to explore together.</p>
          <div className="lobby-form">
            <label htmlFor="room-input">Room name</label>
            <input
              id="room-input" type="text" value={roomInput}
              onChange={(e) => setRoomInput(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && handleJoin()}
              placeholder="e.g. town-square"
              disabled={appState === "connecting"}
            />
            <p className="lobby-hint">Same room name = same world. Share it with a friend!</p>
            <button className="lobby-btn" onClick={handleJoin} disabled={appState === "connecting"}>
              {appState === "connecting" ? "Connecting..." : "Enter World"}
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div>
      <PhaserGame
        roomId={currentRoom}
        onNearbyChange={handleNearbyChange}
        onTalkClicked={handleTalkClicked}
      />

      {/* HUD */}
      <div className="hud">
        <div className="hud-room">
          <span className="hud-dot" style={{ background: isConnected ? "#4ECDC4" : "#FF6B6B" }} />
          {currentRoom}
        </div>
        <div className="hud-players">👥 {playerCount}</div>
        <button className="hud-leave" onClick={handleLeave}>Leave</button>
      </div>

      {/* Call overlay — handles all call states */}
      <CallOverlay
        callState={callState}
        peerId={callPeerId}
        nearbyId={nearbyId}
        onTalkRequest={() => nearbyId && handleTalkClicked(nearbyId)}
        onAccept={handleAccept}
        onDecline={handleDecline}
        onHangUp={handleHangUp}
        isMuted={isMuted}
        onToggleMute={handleToggleMute}
        error={callError}
      />

      <div className="controls-hint">
        WASD / Arrow keys to move · Click to teleport
        {nearbyId && callState === "idle" && " · T = Talk"}
      </div>
    </div>
  );
}
