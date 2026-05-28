// ChatManager — send/receive chat messages over the 'chat' DataChannel
// Supports direct (to one peer) and broadcast (to all peers)

// Prevents the dedup Set from growing without bound in long sessions (M1).
const MAX_SEEN_IDS = 1000;

export class ChatManager extends EventTarget {
  constructor(peerManager) {
    super();
    this._pm = peerManager;
    this._seen = new Set();

    peerManager.addEventListener('message', (e) => {
      const { peerId, label, data } = e.detail;
      if (label !== 'chat') return;
      try {
        const msg = JSON.parse(data);
        if (msg.type === 'chat') this._receive({ ...msg, from: peerId });
      } catch {
        // ignore malformed messages
      }
    });
  }

  // Send directly to one peer (WhatsApp-style 1-on-1)
  sendTo(toPeerId, text) {
    const msg = {
      type: 'chat',
      id: crypto.randomUUID(),
      from: this._pm.localPeerId,
      to: toPeerId,
      text,
      ts: Date.now(),
    };
    this._pm.safeSend(toPeerId, 'chat', JSON.stringify(msg));
    this.dispatchEvent(new CustomEvent('message', { detail: msg }));
    return msg;
  }

  // Broadcast to all peers (group chat)
  send(text) {
    const msg = {
      type: 'chat',
      id: crypto.randomUUID(),
      from: this._pm.localPeerId,
      text,
      ts: Date.now(),
    };
    const payload = JSON.stringify(msg);
    this._pm.getPeerIds().forEach((peerId) => {
      this._pm.safeSend(peerId, 'chat', payload);
    });
    this.dispatchEvent(new CustomEvent('message', { detail: msg }));
    return msg;
  }

  _receive(msg) {
    if (this._seen.has(msg.id)) return;
    // Evict the oldest entry when the Set is full (Sets preserve insertion order)
    if (this._seen.size >= MAX_SEEN_IDS) {
      this._seen.delete(this._seen.values().next().value);
    }
    this._seen.add(msg.id);
    this.dispatchEvent(new CustomEvent('message', { detail: msg }));
  }
}
