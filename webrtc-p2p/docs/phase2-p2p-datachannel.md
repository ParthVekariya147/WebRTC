# Phase 2 — P2P DataChannel

**Status: COMPLETE**  
**Tests: 22/22 unit passing + Playwright E2E passing** (`e2e/phase2.spec.js`)

---

## Goal

Two browsers establish a direct `RTCPeerConnection` and exchange messages over WebRTC DataChannels — no server involvement after ICE completes.

---

## Architecture

```
Alice (offerer)                           Bob (answerer)
──────────────────────────────────────────────────────────
_createOffer(bob)                         _prepareForOffer(alice)
  createDataChannel('chat')    ──offer──►
  createDataChannel('file')    ◄─answer──
  ICE candidates               ←────────►  ICE candidates
  ─────────── RTCPeerConnection connected ────────────
  DataChannel 'chat' open                DataChannel 'chat' open (ondatachannel)
  DataChannel 'file' open                DataChannel 'file' open (ondatachannel)
```

---

## Components

### `SignalingClient` (`client/src/signalingClient.js`)

WebSocket wrapper that fires DOM `CustomEvent`s for each server message:

```js
const signaling = new SignalingClient('ws://localhost:8080');
signaling.addEventListener('room-peers', e => { /* e.detail.peers */ });
signaling.addEventListener('peer-joined', e => { /* e.detail.peerId */ });
```

**Reconnect logic**: exponential backoff, 1 s → 30 s cap. On reconnect, automatically re-sends `join` with the saved `roomId`/`peerId`.

### `PeerManager` (`client/src/peerManager.js`)

Manages the mesh of `RTCPeerConnection` instances.

```
PeerManager
  connections: Map<peerId, RTCPeerConnection>
  channels:    Map<peerId, { chat: RTCDataChannel, file: RTCDataChannel }>
  _pendingCandidates: Map<peerId, RTCIceCandidateInit[]>
  _makingOffer: Map<peerId, boolean>
```

**Key methods:**

| Method | Description |
|---|---|
| `safeSend(peerId, label, data)` | Sends data on a DataChannel only if it's `'open'` |
| `setLocalStream(stream)` | Adds media tracks to all existing connections (Phase 5) |
| `destroy()` | Closes all connections and clears all maps |
| `getPeerIds()` | Returns array of connected peer IDs |

### `ChatManager` (`client/src/chatManager.js`)

Sends/receives JSON chat messages over the `chat` DataChannel.

```js
chatManager.send('hello');             // broadcast to all peers
chatManager.sendTo('bob', 'hello');   // direct message to one peer
```

**Message format:**
```json
{ "type": "chat", "id": "uuid", "from": "alice", "text": "hello", "ts": 1234567890 }
```

Deduplicates by `id` so a forwarded message can't appear twice.

---

## Perfect Negotiation

Handles **offer collision** (glare) — both peers try to offer simultaneously.

**Polite/impolite assignment**: the peer with the lexicographically smaller `peerId` is polite.

```js
_isPolite(peerId) {
    return this.localPeerId < peerId;
}
```

**On collision:**
- **Impolite peer**: ignores the incoming offer, continues with its own
- **Polite peer**: rolls back its own offer and accepts the incoming one

```js
if (offerCollision) {
    if (!this._isPolite(from)) return;   // impolite: ignore
    await Promise.all([
        pc.setLocalDescription({ type: 'rollback' }),
        pc.setRemoteDescription(new RTCSessionDescription(sdp)),
    ]);
}
```

---

## ICE Candidate Queue

ICE candidates can arrive before `setRemoteDescription` completes. Queuing them prevents silent connection failure:

```js
if (pc.remoteDescription) {
    await pc.addIceCandidate(candidate);
} else {
    this._pendingCandidates.get(from).push(candidate);  // buffer
}
// drains immediately after setRemoteDescription
```

---

## DataChannel Configuration

| Channel | Ordered | Use |
|---|---|---|
| `chat` | `true` | Text messages — must arrive in order |
| `file` | `false` | File chunks — reordering handled by chunk index, avoids head-of-line blocking |

**Binary type**: the `file` channel uses `channel.binaryType = 'arraybuffer'` so binary frames arrive as `ArrayBuffer` instead of the default `Blob`. This is required for `FileManager` (Phase 3) to decode binary chunk headers.

---

## Tests

### Unit tests

```bash
cd client && npm test
```

| File | Tests | What they cover |
|---|---|---|
| `src/chatManager.test.js` | 5 | `send`, `sendTo`, deduplication, event emission |
| `src/sendMessage.test.js` | 17 | Input clearing, offline guard, empty message guard, media data |

### E2E (Playwright)

```bash
npx playwright test e2e/phase2.spec.js
```

**Exit criteria verified:**
1. Tab A and Tab B connect, each appears in the other's peer list
2. ICE reaches `connected` (shown by "Online — Direct P2P" in status)
3. Message crosses Alice → Bob over the `chat` DataChannel
4. Message crosses Bob → Alice
5. Input field clears immediately after send
6. `peer-left` fires when Bob's tab closes; Alice's status shows "offline"

---

## Files

| File | Role |
|---|---|
| `client/src/signalingClient.js` | WebSocket wrapper + auto-reconnect |
| `client/src/peerManager.js` | RTCPeerConnection mesh + perfect negotiation |
| `client/src/chatManager.js` | Chat messages over DataChannel |
| `client/src/iceConfig.js` | STUN server list |
| `client/src/config.js` | `SIGNALING_URL` constant |
| `client/src/chatManager.test.js` | Unit tests |
| `client/src/sendMessage.test.js` | Unit tests |
| `e2e/phase2.spec.js` | Playwright E2E exit test |
