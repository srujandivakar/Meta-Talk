import { socket } from "../socket";
import { EVENTS, WebRtcSdpPayload, WebRtcIcePayload } from "@mping/shared";

// ─────────────────────────────────────────────────────────────────
//  VOICE CHAT  —  WebRTC peer-to-peer audio manager
//
//  WHY WebRTC and not a media server?
//  WebRTC is direct browser-to-browser. Once connected, our server
//  carries ZERO audio data. This is completely free at any scale.
//
//  Our Socket.IO server is only used for "signaling" — the handshake
//  phase where the two browsers exchange:
//    1. SDP (Session Description Protocol) — "here's my audio codecs"
//    2. ICE candidates — "here's my IP addresses to try connecting to"
//  Once those are exchanged, the browsers connect directly.
//
//  STUN servers help browsers behind NAT discover their public IP.
//  We use Google's free public STUN servers (no account needed).
//  For strict corporate/symmetric NAT, a TURN server would be needed
//  (that's a paid service needed only for <5% of users in production).
// ─────────────────────────────────────────────────────────────────

const ICE_SERVERS: RTCIceServer[] = [
  { urls: "stun:stun.l.google.com:19302" },
  { urls: "stun:stun1.l.google.com:19302" },
];

export type CallState = "idle" | "calling" | "receiving" | "connected";

export interface VoiceChatCallbacks {
  onStateChange: (state: CallState) => void;
  onError: (msg: string) => void;
}

class VoiceChatManager {
  private pc: RTCPeerConnection | null = null;
  private localStream: MediaStream | null = null;
  private remoteAudio: HTMLAudioElement | null = null;

  private peerId: string | null = null;
  private state: CallState = "idle";

  // ICE candidate buffer — candidates can arrive before the remote
  // description is set (race condition). We queue them and flush after.
  private iceBuffer: RTCIceCandidateInit[] = [];
  private remoteDescSet = false;

  private callbacks: VoiceChatCallbacks = {
    onStateChange: () => {},
    onError: () => {},
  };

  // ── PUBLIC API ───────────────────────────────────────────────

  /** Must be called once after the socket connects. */
  init(callbacks: VoiceChatCallbacks) {
    this.callbacks = callbacks;
    this.setupSocketListeners();
  }

  /** Caller side: initiate a call to peerId. */
  async initiateCall(peerId: string) {
    if (this.state !== "idle") return;
    this.peerId = peerId;
    this.setState("calling");

    try {
      await this.setupLocalStream();
      this.createPeerConnection();

      const offer = await this.pc!.createOffer();
      await this.pc!.setLocalDescription(offer);

      socket.emit(EVENTS.WEBRTC_OFFER, {
        to: peerId,
        sdp: offer,
      } as WebRtcSdpPayload);
    } catch (err) {
      this.handleError("Microphone access denied or unavailable.");
    }
  }

  /** Callee side: accept an incoming call. Called after user presses Accept. */
  async acceptCall(peerId: string, offerSdp: RTCSessionDescriptionInit) {
    if (this.state !== "receiving") return;
    this.peerId = peerId;

    try {
      await this.setupLocalStream();
      this.createPeerConnection();

      await this.pc!.setRemoteDescription(new RTCSessionDescription(offerSdp));
      this.remoteDescSet = true;
      await this.flushIceBuffer();

      const answer = await this.pc!.createAnswer();
      await this.pc!.setLocalDescription(answer);

      socket.emit(EVENTS.WEBRTC_ANSWER, {
        to: peerId,
        sdp: answer,
      } as WebRtcSdpPayload);
    } catch (err) {
      this.handleError("Microphone access denied or unavailable.");
    }
  }

  /** End the current call from either side. */
  endCall() {
    if (this.peerId && this.state !== "idle") {
      socket.emit(EVENTS.CALL_END, { to: this.peerId });
    }
    this.cleanup();
  }

  /** Mute or unmute the local microphone without ending the call. */
  setMuted(muted: boolean) {
    this.localStream?.getAudioTracks().forEach((t) => {
      t.enabled = !muted;
    });
  }

  getState() { return this.state; }
  getPeerId() { return this.peerId; }

  // ── PRIVATE ──────────────────────────────────────────────────

  private setState(s: CallState) {
    this.state = s;
    this.callbacks.onStateChange(s);
  }

  private async setupLocalStream() {
    // Request microphone only — no video needed for voice chat.
    // The browser will show a permission prompt on first use.
    this.localStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,   // Remove echo from speakers
        noiseSuppression: true,   // Filter background noise
        autoGainControl: true,    // Normalize volume levels
      },
      video: false,
    });
  }

  private createPeerConnection() {
    this.pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
    this.remoteDescSet = false;
    this.iceBuffer = [];

    // Add our microphone tracks to the connection
    this.localStream?.getTracks().forEach((track) => {
      this.pc!.addTrack(track, this.localStream!);
    });

    // When we get a remote audio track, play it through an <audio> element.
    // WHY not use React state for this? Because audio playback must be
    // triggered by a direct DOM action to satisfy browser autoplay policies.
    this.pc.ontrack = (event) => {
      if (!this.remoteAudio) {
        this.remoteAudio = document.createElement("audio");
        this.remoteAudio.autoplay = true;
        document.body.appendChild(this.remoteAudio);
      }
      this.remoteAudio.srcObject = event.streams[0];
      this.setState("connected");
    };

    // ICE candidates describe our network paths (local IP, public IP, relay).
    // We send each one to the peer via the server as they're discovered.
    this.pc.onicecandidate = (event) => {
      if (event.candidate && this.peerId) {
        socket.emit(EVENTS.WEBRTC_ICE, {
          to: this.peerId,
          candidate: event.candidate.toJSON(),
        } as WebRtcIcePayload);
      }
    };

    this.pc.onconnectionstatechange = () => {
      if (this.pc?.connectionState === "failed") {
        this.handleError("Connection failed. You may be behind a strict firewall.");
      }
      if (this.pc?.connectionState === "disconnected") {
        this.cleanup();
      }
    };
  }

  private setupSocketListeners() {
    // ── Receive WebRTC offer (we are the callee) ────────────────
    // Note: CALL_ACCEPT is handled in App.tsx (UI layer).
    // We only handle the WebRTC negotiation here.
    socket.on(EVENTS.WEBRTC_OFFER, async (payload: WebRtcSdpPayload & { from: string }) => {
      // The accept UI in App.tsx stores the offer until the user clicks Accept.
      // We store it in a pending slot so acceptCall() can use it.
      this._pendingOffer = { from: payload.from, sdp: payload.sdp };
    });

    socket.on(EVENTS.WEBRTC_ANSWER, async (payload: WebRtcSdpPayload) => {
      if (!this.pc) return;
      await this.pc.setRemoteDescription(new RTCSessionDescription(payload.sdp));
      this.remoteDescSet = true;
      await this.flushIceBuffer();
    });

    socket.on(EVENTS.WEBRTC_ICE, async (payload: WebRtcIcePayload) => {
      // Buffer candidates if remote desc isn't set yet — common race condition
      if (!this.remoteDescSet || !this.pc) {
        this.iceBuffer.push(payload.candidate);
        return;
      }
      try {
        await this.pc.addIceCandidate(new RTCIceCandidate(payload.candidate));
      } catch {
        // Silently ignore invalid candidates (can happen during renegotiation)
      }
    });

    socket.on(EVENTS.CALL_END, () => {
      this.cleanup();
    });
  }

  private async flushIceBuffer() {
    for (const candidate of this.iceBuffer) {
      try {
        await this.pc?.addIceCandidate(new RTCIceCandidate(candidate));
      } catch { /* ignore */ }
    }
    this.iceBuffer = [];
  }

  private cleanup() {
    this.localStream?.getTracks().forEach((t) => t.stop());
    this.pc?.close();
    if (this.remoteAudio) {
      this.remoteAudio.srcObject = null;
      this.remoteAudio.remove();
      this.remoteAudio = null;
    }
    this.pc = null;
    this.localStream = null;
    this.peerId = null;
    this.remoteDescSet = false;
    this.iceBuffer = [];
    this._pendingOffer = null;
    this.setState("idle");
  }

  private handleError(msg: string) {
    this.cleanup();
    this.callbacks.onError(msg);
  }

  // Temporary storage for an offer that arrived before user clicked Accept
  _pendingOffer: { from: string; sdp: RTCSessionDescriptionInit } | null = null;

  /** Called by App.tsx when the receiving user's state should be set to "receiving" */
  markReceiving(fromId: string) {
    this.peerId = fromId;
    this.setState("receiving");
  }
}

// Export a singleton — one voice chat state for the entire app
export const voiceChat = new VoiceChatManager();
