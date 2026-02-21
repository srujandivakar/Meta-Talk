import { CallState } from "../voice/VoiceChat";

interface CallOverlayProps {
  callState: CallState;
  peerId: string | null;          // who we're calling / being called by
  nearbyId: string | null;        // player in proximity range
  onTalkRequest: () => void;      // user clicks "Talk" button
  onAccept: () => void;
  onDecline: () => void;
  onHangUp: () => void;
  isMuted: boolean;
  onToggleMute: () => void;
  error: string | null;
}

// Short display name: just the first 8 chars of the socket ID
const shortId = (id: string | null) => id?.slice(0, 8) ?? "unknown";

export function CallOverlay({
  callState,
  peerId,
  nearbyId,
  onTalkRequest,
  onAccept,
  onDecline,
  onHangUp,
  isMuted,
  onToggleMute,
  error,
}: CallOverlayProps) {
  // ── PROXIMITY "Talk" button ─────────────────────────────────
  // When idle and someone is nearby, show a subtle Talk button in the HUD.
  // This complements the in-world "[T] Talk" Phaser label.
  if (callState === "idle" && nearbyId) {
    return (
      <div className="call-proximity">
        <span className="call-prox-dot" />
        <span className="call-prox-label">
          Player <strong>{shortId(nearbyId)}</strong> is nearby
        </span>
        <button className="call-btn call-btn--talk" onClick={onTalkRequest}>
          🎙 Talk
        </button>
      </div>
    );
  }

  // ── OUTGOING: waiting for the other player to accept ────────
  if (callState === "calling") {
    return (
      <div className="call-overlay">
        <div className="call-card">
          <div className="call-avatar">🎙</div>
          <p className="call-status">Calling…</p>
          <p className="call-peer">{shortId(peerId)}</p>
          <p className="call-hint">Waiting for them to accept</p>
          <button className="call-btn call-btn--end" onClick={onHangUp}>
            Cancel
          </button>
        </div>
      </div>
    );
  }

  // ── INCOMING: receiver sees Accept / Decline ─────────────────
  if (callState === "receiving") {
    return (
      <div className="call-overlay">
        <div className="call-card">
          <div className="call-avatar call-avatar--ring">🎙</div>
          <p className="call-status">Incoming voice call</p>
          <p className="call-peer">{shortId(peerId)}</p>
          <div className="call-actions">
            <button className="call-btn call-btn--accept" onClick={onAccept}>
              ✓ Accept
            </button>
            <button className="call-btn call-btn--decline" onClick={onDecline}>
              ✕ Decline
            </button>
          </div>
        </div>
      </div>
    );
  }

  // ── CONNECTED: active call HUD (small, non-intrusive) ───────
  if (callState === "connected") {
    return (
      <div className="call-active">
        <span className="call-active-dot" />
        <span className="call-active-label">
          🎙 Voice call with <strong>{shortId(peerId)}</strong>
        </span>
        <button
          className={`call-btn call-btn--mute ${isMuted ? "call-btn--muted" : ""}`}
          onClick={onToggleMute}
          title={isMuted ? "Unmute" : "Mute"}
        >
          {isMuted ? "🔇" : "🎤"}
        </button>
        <button className="call-btn call-btn--end" onClick={onHangUp}>
          End
        </button>
      </div>
    );
  }

  // ── ERROR ───────────────────────────────────────────────────
  if (error) {
    return (
      <div className="call-overlay">
        <div className="call-card call-card--error">
          <p>⚠️ {error}</p>
          <button className="call-btn call-btn--end" onClick={onHangUp}>
            OK
          </button>
        </div>
      </div>
    );
  }

  return null;
}
