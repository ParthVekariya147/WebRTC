# WebRTC P2P — Project Documentation

A browser-based peer-to-peer application built on WebRTC. Peers connect directly without a media relay; the signaling server only bootstraps connections and is never in the data path.

---

## Architecture

```
  Browser A                  Signaling Server               Browser B
     │                        (Node.js + ws)                    │
     │──── join(roomId) ──────────────────────────────────────► │
     │◄─── room-peers([B]) ──────────────────────────────────── │
     │                                                           │
     │──── offer ────────────► routes ──────────────────────── ►│
     │◄─── answer ───────────◄ routes ◄──────────────────────── │
     │──── ice-candidate ────► routes ──────────────────────── ►│
     │◄─── ice-candidate ────◄ routes ◄──────────────────────── │
     │                                                           │
     │◄══════════════ RTCPeerConnection (direct) ══════════════►│
     │              DataChannel 'chat'  (ordered)                │
     │              DataChannel 'file'  (unordered)              │
```

The signaling server exits the picture once ICE completes. All chat and file data flows peer-to-peer.

---

## Tech Stack

| Layer | Technology |
|---|---|
| Signaling server | Node.js + `ws` (WebSocket) |
| Client bundler | Vite |
| Client runtime | Vanilla JS ES modules |
| P2P transport | WebRTC (`RTCPeerConnection`, `RTCDataChannel`) |
| Unit tests | Vitest |
| E2E tests | Playwright |

---

## Project Structure

```
webrtc-p2p/
├── server/
│   ├── server.js           # WebSocket signaling server
│   ├── server.test.js      # Unit tests (8 tests)
│   └── package.json
├── client/
│   ├── index.html          # Full UI (light/dark theme)
│   ├── src/
│   │   ├── config.js         # SIGNALING_URL constant
│   │   ├── iceConfig.js      # ICE/STUN server list
│   │   ├── signalingClient.js # WebSocket wrapper + reconnect
│   │   ├── peerManager.js    # RTCPeerConnection mesh manager
│   │   ├── chatManager.js    # Chat messages over DataChannel
│   │   ├── fileManager.js    # File transfer over DataChannel (Phase 3)
│   │   ├── chatManager.test.js
│   │   └── sendMessage.test.js
│   ├── vite.config.js
│   └── package.json
├── e2e/
│   ├── phase2.spec.js      # P2P DataChannel E2E (Playwright)
│   ├── phase3.spec.js      # File transfer E2E (Phase 3)
│   └── connection.spec.js
├── playwright.config.js
└── package.json
```

---

## Getting Started

### Prerequisites
- Node.js 18+
- npm 9+

### Run locally

```bash
# 1. Start the signaling server
cd server && npm start
# Listening on ws://localhost:8080

# 2. Start the Vite dev server (separate terminal)
cd client && npm run dev
# http://localhost:5173
```

Open two browser tabs to `http://localhost:5173`, enter the same Room ID in both, and connect.

### Run tests

```bash
# Unit tests — server (8 tests)
npm run test:unit:server

# Unit tests — client (22+ tests)
npm run test:unit:client

# E2E — Playwright
npm run test:e2e
```

---

## Phases

### Phase 1 — Signaling Server `COMPLETE`

**Goal:** Route SDP and ICE between peers. Never touch media or data.

**Key behaviors:**
- `join` → sends `room-peers` to the newcomer, `peer-joined` to existing peers
- Routes `offer` / `answer` / `ice-candidate` to the target `peerId`
- Room capacity: 5 peers max
- Input validation on `roomId` and `peerId` (length ≤ 64, string type)
- Empty-room cleanup on disconnect
- `peer-left` broadcast when a peer disconnects

**Tests:** `server/server.test.js` — 8/8 passing

---

### Phase 2 — P2P DataChannel `COMPLETE`

**Goal:** Two browsers establish a direct `RTCPeerConnection` and exchange messages over DataChannels.

**Key behaviors:**
- Two DataChannels per peer pair: `chat` (ordered) + `file` (unordered)
- **Perfect negotiation** (glare-safe): polite/impolite peer roles determined by `localPeerId < remotePeerId`; polite peer rolls back on offer collision
- ICE candidate queue: candidates received before `setRemoteDescription` are buffered and drained immediately after
- Stale answer guard: answers arriving when the connection is already `stable` are silently dropped
- `onnegotiationneeded` handler wired for Phase 5 renegotiation (media tracks)
- `safeSend()`: guards against sending on a closed DataChannel
- `SignalingClient` auto-reconnects with exponential backoff (1 s → 30 s max)

**Tests:**
- `client/src/chatManager.test.js` — 5 tests
- `client/src/sendMessage.test.js` — 17 tests
- `e2e/phase2.spec.js` — Playwright E2E: ICE reaches `connected`, both channels open, messages cross both directions, `peer-left` fires on tab close

---

### Phase 3 — File Transfer `COMPLETE`

**Goal:** Transfer arbitrary files peer-to-peer over the `file` DataChannel using chunked binary transfer.

**Key behaviors:**
- `FileManager` class handles chunking, reassembly, and progress tracking
- Chunk size: 16 KB (safe SCTP limit)
- Protocol: JSON control frames (`file-start`, `file-end`) + raw `ArrayBuffer` binary chunks
- Sender emits `progress` events (0–100 %) per chunk ACK
- Receiver assembles chunks into a `Blob`, triggers automatic browser download
- Multiple concurrent transfers supported (keyed by transfer ID)
- Transfer aborted cleanly if the peer disconnects mid-transfer

**Tests:**
- `client/src/fileManager.test.js` — unit tests for chunking, reassembly, and progress
- `e2e/phase3.spec.js` — Playwright E2E: send 1 MB file, verify download blob

---

### Phase 4 — Multi-Peer Mesh _(planned)_

Extend to 3–5 peers. Each new joiner receives the full peer list (`room-peers`) and creates offers to all existing peers simultaneously. Full mesh: N×(N-1)/2 connections.

---

### Phase 5 — Video / Audio _(planned)_

`getUserMedia` → `addTrack` → `onnegotiationneeded` fires → renegotiates SDP. The handler is already wired in `peerManager.js`. Requires TURN relay for peers behind symmetric NAT.

---

### Phase 7 — Production _(planned)_

- Replace `ws://` with `wss://` (TLS)
- Add TURN server credentials in `iceConfig.js`
- Deploy signaling server (Railway / Fly.io / Render)
- Deploy client (Vercel / Netlify)

---

## Core Modules

### `SignalingClient`
WebSocket wrapper that emits DOM `CustomEvent`s for each message type. Stores `roomId`/`peerId` and re-joins automatically after reconnect.

### `PeerManager`
Manages a `Map<peerId, RTCPeerConnection>` and a `Map<peerId, {chat, file}>` channel map. Exposes:
- `safeSend(peerId, label, data)` — guards channel state before sending
- `setLocalStream(stream)` — adds media tracks to all existing connections
- `destroy()` — closes all connections

### `ChatManager`
Sends/receives JSON chat frames over the `chat` DataChannel. Supports broadcast (`send`) and direct (`sendTo`). Deduplicates by message `id`.

### `FileManager`
Sends/receives files over the `file` DataChannel. See Phase 3 above.

---

## Design Decisions

| Decision | Rationale |
|---|---|
| Two DataChannels per pair | `chat` is ordered (messages must arrive in order); `file` is unordered (chunk reordering handled by index, avoids head-of-line blocking) |
| Perfect negotiation | Spec-recommended pattern for glare-free renegotiation; required when both peers can trigger offers (e.g., media tracks) |
| ICE candidate queuing | Candidates can arrive before `setRemoteDescription` completes; buffering prevents silent connection failure |
| Exponential backoff reconnect | Prevents thundering-herd on server restart; caps at 30 s |
| `peerId` from `crypto.randomUUID()` | Collision-free, no server coordination needed |
