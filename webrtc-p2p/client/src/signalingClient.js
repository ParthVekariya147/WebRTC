// SignalingClient — WebSocket wrapper with exponential backoff reconnect
// Phase 1 + reconnect added per eng review (D3)
import { log } from './logger.js';

export class SignalingClient extends EventTarget {
  constructor(serverUrl) {
    super();
    this._url = serverUrl;
    this._roomId = null;
    this._peerId = null;
    this._reconnectDelay = 1000;
    this._maxDelay = 30000;
    this._dead = false;
    this._connect();
  }

  _connect() {
    if (this._dead) return;
    this.ws = new WebSocket(this._url);

    this.ws.onopen = () => {
      log.info('connected');
      this._reconnectDelay = 1000;
      this.dispatchEvent(new CustomEvent('connected'));
      // Re-join after reconnect if we were in a room
      if (this._roomId && this._peerId) {
        this._sendRaw({ type: 'join', roomId: this._roomId, peerId: this._peerId });
      }
    };

    this.ws.onmessage = (e) => {
      let msg;
      try { msg = JSON.parse(e.data); } catch { return; }
      this.dispatchEvent(new CustomEvent(msg.type, { detail: msg }));
    };

    this.ws.onclose = () => {
      if (this._dead) return;
      log.warn(`disconnected, retrying in ${this._reconnectDelay}ms`);
      setTimeout(() => this._connect(), this._reconnectDelay);
      this._reconnectDelay = Math.min(this._reconnectDelay * 2, this._maxDelay);
    };

    this.ws.onerror = (err) => {
      log.error('WebSocket error:', err);
      this.dispatchEvent(new CustomEvent('error', { detail: { message: 'Connection failed' } }));
    };
  }

  _sendRaw(msg) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg));
    }
  }

  send(msg) { this._sendRaw(msg); }

  join(roomId, peerId) {
    this._roomId = roomId;
    this._peerId = peerId;
    this._sendRaw({ type: 'join', roomId, peerId });
  }

  sendOffer(to, from, sdp) { this._sendRaw({ type: 'offer', to, from, sdp }); }
  sendAnswer(to, from, sdp) { this._sendRaw({ type: 'answer', to, from, sdp }); }
  sendIce(to, from, candidate) { this._sendRaw({ type: 'ice-candidate', to, from, candidate }); }

  destroy() {
    this._dead = true;
    this.ws && this.ws.close();
  }
}
