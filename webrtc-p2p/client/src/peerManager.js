// PeerManager — manages RTCPeerConnection mesh for 2-5 peers
// Includes: ICE candidate queue (D2), two DataChannels per peer (D4),
//           try/catch (D7), perfect negotiation (Phase 3 — glare-safe)
import { ICE_CONFIG } from './iceConfig.js';
import { log } from './logger.js';

const MAX_PENDING_ICE = 100;

// 5 Mbps ceiling lets 1080p breathe; no floor — ABR degrades gracefully under congestion.
async function _applyVideoQuality(sender) {
    try {
        const params = sender.getParameters();
        if (!params.encodings?.length) params.encodings = [{}];
        params.encodings[0].maxBitrate = 5_000_000;
        params.degradationPreference = 'balanced'; // degrade fps AND resolution proportionally under congestion
        await sender.setParameters(params);
    } catch (_) { /* setParameters unsupported — graceful fallback */ }
}

// Prefer AV1 → VP9 → H264 → VP8 for best quality-per-bit; fallback keeps weak devices working.
function _applyCodecPreference(transceiver) {
    try {
        const caps = RTCRtpReceiver.getCapabilities?.('video');
        if (!caps || !transceiver.setCodecPreferences) return;
        const order = ['video/AV1', 'video/VP9', 'video/H264', 'video/VP8'];
        const sorted = [...caps.codecs].sort((a, b) => {
            const ai = order.indexOf(a.mimeType);
            const bi = order.indexOf(b.mimeType);
            return (ai === -1 ? 999 : ai) - (bi === -1 ? 999 : bi);
        });
        transceiver.setCodecPreferences(sorted);
    } catch (_) { /* codec preferences unsupported — use browser default */ }
}

export class PeerManager extends EventTarget {
  constructor(localPeerId, signaling) {
    super();
    this.localPeerId = localPeerId;
    this.signaling = signaling;

    // peerId → RTCPeerConnection
    this.connections = new Map();
    // peerId → { chat: RTCDataChannel, file: RTCDataChannel }
    this.channels = new Map();
    // ICE candidate queue: peerId → RTCIceCandidateInit[]
    // Drains after setRemoteDescription completes (D2 — prevents silent connection failure)
    this._pendingCandidates = new Map();
    // Perfect negotiation state: peerId → boolean (are we currently making an offer?)
    this._makingOffer = new Map();

    this.localStream = null;

    signaling.addEventListener('room-peers', (e) => {
      // Guard: skip peers we already have a connection for (H4).
      // On reconnect, room-peers fires again; without this guard the old PC is
      // overwritten without being closed, leaking the connection.
      e.detail.peers.forEach((pid) => {
        if (!this.connections.has(pid)) this._createOffer(pid);
      });
    });
    signaling.addEventListener('peer-joined', (e) => {
      this._prepareForOffer(e.detail.peerId);
    });
    signaling.addEventListener('offer', (e) => this._handleOffer(e.detail));
    signaling.addEventListener('answer', (e) => this._handleAnswer(e.detail));
    signaling.addEventListener('ice-candidate', (e) => this._handleIce(e.detail));
    signaling.addEventListener('peer-left', (e) => this._closePeer(e.detail.peerId));
  }

  // Polite peer = the one with the lexicographically smaller peerId.
  // The polite peer yields when a collision (glare) occurs.
  _isPolite(peerId) {
    return this.localPeerId < peerId;
  }

  _createPeerConnection(peerId) {
    const pc = new RTCPeerConnection(ICE_CONFIG);
    this.connections.set(peerId, pc);
    this._pendingCandidates.set(peerId, []);
    this._makingOffer.set(peerId, false);

    pc.onicecandidate = ({ candidate }) => {
      if (candidate) {
        this.signaling.sendIce(peerId, this.localPeerId, candidate);
      }
    };

    pc.oniceconnectionstatechange = () => {
      log.debug(`[peer:${peerId}] ICE state:`, pc.iceConnectionState);
      this.dispatchEvent(new CustomEvent('icestate', { detail: { peerId, state: pc.iceConnectionState } }));
    };

    // Renegotiation path (Phase 5: addTrack for video/audio fires this).
    // Uses implicit setLocalDescription() — browser atomically creates + sets the
    // offer, eliminating the stale-signalingState window that caused silent drops.
    pc.onnegotiationneeded = async () => {
      if (this._makingOffer.get(peerId)) return;
      try {
        this._makingOffer.set(peerId, true);
        await pc.setLocalDescription();          // implicit offer — no stale-state gap
        this.signaling.sendOffer(peerId, this.localPeerId, pc.localDescription);
      } catch (err) {
        log.error(`[peer:${peerId}] onnegotiationneeded failed:`, err);
      } finally {
        this._makingOffer.set(peerId, false);
      }
    };

    pc.ondatachannel = (e) => {
      // Answerer side receives channels created by the offerer
      this._registerChannel(peerId, e.channel);
    };

    pc.ontrack = (e) => {
      this.dispatchEvent(new CustomEvent('track', { detail: { peerId, stream: e.streams[0] } }));
    };

    if (this.localStream) {
      this.localStream.getTracks().forEach((t) => {
        if (t.kind === 'video') t.contentHint = 'detail';
        const sender = pc.addTrack(t, this.localStream);
        if (t.kind === 'video') {
          const transceiver = pc.getTransceivers().find(tr => tr.sender === sender);
          if (transceiver) _applyCodecPreference(transceiver);
          _applyVideoQuality(sender);
        }
      });
    }

    return pc;
  }

  _registerChannel(peerId, channel) {
    const label = channel.label; // 'chat' or 'file'
    const existing = this.channels.get(peerId) || {};
    existing[label] = channel;
    this.channels.set(peerId, existing);

    // Binary frames must arrive as ArrayBuffer so FileManager can decode the header.
    // Default binaryType is 'blob' which breaks DataView / Uint8Array operations.
    if (label === 'file') channel.binaryType = 'arraybuffer';

    channel.onopen = () => {
      log.debug(`[peer:${peerId}] DataChannel '${label}' open`);
      this.dispatchEvent(new CustomEvent('channelopen', { detail: { peerId, label } }));
    };

    channel.onmessage = (e) => {
      this.dispatchEvent(new CustomEvent('message', { detail: { peerId, label, data: e.data } }));
    };

    channel.onclose = () => {
      log.warn(`[peer:${peerId}] DataChannel '${label}' closed`);
    };
  }

  async _createOffer(peerId) {
    try {
      const pc = this._createPeerConnection(peerId);

      // Set makingOffer=true BEFORE createDataChannel so that any onnegotiationneeded
      // events fired by createDataChannel see the flag and exit — only the explicit
      // createOffer below runs, preventing a double-offer race.
      this._makingOffer.set(peerId, true);

      // Offerer creates both channels (D4 — separate chat + file channels)
      const chatChannel = pc.createDataChannel('chat', { ordered: true });
      const fileChannel  = pc.createDataChannel('file', { ordered: true });
      this._registerChannel(peerId, chatChannel);
      this._registerChannel(peerId, fileChannel);

      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      this.signaling.sendOffer(peerId, this.localPeerId, pc.localDescription);
    } catch (err) {
      log.error(`[peer:${peerId}] _createOffer failed:`, err);
    } finally {
      this._makingOffer.set(peerId, false);
    }
  }

  _prepareForOffer(peerId) {
    // Answerer side — create connection and wait for offer
    if (!this.connections.has(peerId)) {
      this._createPeerConnection(peerId);
    }
  }

  async _handleOffer({ from, sdp }) {
    try {
      let pc = this.connections.get(from);
      if (!pc) pc = this._createPeerConnection(from);

      const makingOffer = this._makingOffer.get(from) ?? false;
      const offerCollision = pc.signalingState !== 'stable' || makingOffer;

      // Perfect negotiation: impolite peer ignores colliding offer; polite peer rolls back
      if (offerCollision) {
        if (!this._isPolite(from)) {
          log.debug(`[peer:${from}] offer collision — impolite, ignoring`);
          return;
        }
        // Polite peer: rollback and accept incoming offer
        log.debug(`[peer:${from}] offer collision — polite, rolling back`);
        await Promise.all([
          pc.setLocalDescription({ type: 'rollback' }),
          pc.setRemoteDescription(new RTCSessionDescription(sdp)),
        ]);
      } else {
        await pc.setRemoteDescription(new RTCSessionDescription(sdp));
      }

      await this._drainCandidates(from, pc);
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      this.signaling.sendAnswer(from, this.localPeerId, pc.localDescription);
    } catch (err) {
      log.error(`[peer:${from}] _handleOffer failed:`, err);
    }
  }

  async _handleAnswer({ from, sdp }) {
    try {
      const pc = this.connections.get(from);
      if (!pc) return;
      if (pc.signalingState === 'stable') {
        // Stale answer from a resolved collision — ignore safely
        log.debug(`[peer:${from}] stale answer ignored (already stable)`);
        return;
      }
      await pc.setRemoteDescription(new RTCSessionDescription(sdp));
      await this._drainCandidates(from, pc);
    } catch (err) {
      log.error(`[peer:${from}] _handleAnswer failed:`, err);
    }
  }

  async _handleIce({ from, candidate }) {
    try {
      const pc = this.connections.get(from);
      if (!pc) return;

      if (pc.remoteDescription) {
        await pc.addIceCandidate(new RTCIceCandidate(candidate));
      } else {
        // Queue until setRemoteDescription completes (D2 — the fix).
        // Cap at MAX_PENDING_ICE to prevent memory DoS (H5).
        const queue = this._pendingCandidates.get(from) || [];
        if (queue.length < MAX_PENDING_ICE) {
          queue.push(candidate);
          this._pendingCandidates.set(from, queue);
        }
      }
    } catch (err) {
      // Non-fatal — stale/duplicate candidates throw harmlessly
      log.warn(`[peer:${from}] addIceCandidate warning:`, err.message);
    }
  }

  async _drainCandidates(peerId, pc) {
    const queue = this._pendingCandidates.get(peerId) || [];
    this._pendingCandidates.set(peerId, []);
    for (const candidate of queue) {
      try {
        await pc.addIceCandidate(new RTCIceCandidate(candidate));
      } catch (err) {
        log.warn(`[peer:${peerId}] drain addIceCandidate warning:`, err.message);
      }
    }
  }

  _closePeer(peerId) {
    const pc = this.connections.get(peerId);
    if (pc) {
      pc.close();
      this.connections.delete(peerId);
    }
    this.channels.delete(peerId);
    this._pendingCandidates.delete(peerId);
    this._makingOffer.delete(peerId);
    this.dispatchEvent(new CustomEvent('peerleft', { detail: { peerId } }));
  }

  setLocalStream(stream) {
    this.localStream = stream;
    if (!stream) {
      // Remove all media senders so remote peers get renegotiation + removetrack event —
      // without this the remote tile stays frozen/black after stopBroadcast.
      this.connections.forEach((pc) => {
        pc.getSenders()
          .filter(s => s.track)
          .forEach(s => { try { pc.removeTrack(s); } catch (_) {} });
      });
      return;
    }
    this.connections.forEach((pc) => {
      stream.getTracks().forEach((t) => {
        if (t.kind === 'video') t.contentHint = 'detail';
        const sender = pc.addTrack(t, stream);
        if (t.kind === 'video') {
          const transceiver = pc.getTransceivers().find(tr => tr.sender === sender);
          if (transceiver) _applyCodecPreference(transceiver);
          _applyVideoQuality(sender);
        }
      });
    });
  }

  // Safe send — guards against sending on a closed channel
  safeSend(peerId, label, data) {
    const peerChannels = this.channels.get(peerId);
    if (!peerChannels) return false;
    const channel = peerChannels[label];
    if (!channel || channel.readyState !== 'open') return false;
    channel.send(data);
    return true;
  }

  getChannel(peerId, label) {
    const peerChannels = this.channels.get(peerId);
    return peerChannels ? peerChannels[label] : null;
  }

  getPeerIds() {
    return Array.from(this.connections.keys());
  }

  destroy() {
    this.connections.forEach((pc) => pc.close());
    this.connections.clear();
    this.channels.clear();
    this._pendingCandidates.clear();
    this._makingOffer.clear();
  }
}
