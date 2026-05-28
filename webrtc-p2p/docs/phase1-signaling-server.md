# Phase 1 — Signaling Server

**Status: COMPLETE**  
**Tests: 8/8 passing** (`server/server.test.js`)

---

## Goal

A minimal WebSocket server that routes SDP and ICE messages between peers. The server never sees or stores media or DataChannel content — its only job is to bootstrap connections and then get out of the way.

---

## Architecture

```
Client A ──── WebSocket ────► Signaling Server ◄──── WebSocket ──── Client B
                               (routes messages)
```

Once ICE completes, all traffic flows peer-to-peer. The signaling server is idle until a new peer joins or a peer disconnects.

---

## Protocol Messages

| Direction | Message Type | Payload | Purpose |
|---|---|---|---|
| Client → Server | `join` | `{ roomId, peerId }` | Register in a room |
| Server → Client | `room-peers` | `{ peers: string[] }` | List of existing peers sent to newcomer |
| Server → Client | `peer-joined` | `{ peerId }` | Broadcast to existing peers when someone joins |
| Server → Client | `peer-left` | `{ peerId }` | Broadcast when a peer disconnects |
| Client → Server | `offer` | `{ to, from, sdp }` | Route SDP offer to target peer |
| Client → Server | `answer` | `{ to, from, sdp }` | Route SDP answer to target peer |
| Client → Server | `ice-candidate` | `{ to, from, candidate }` | Route ICE candidate to target peer |
| Server → Client | `error` | `{ message }` | Validation failure (invalid roomId, room full) |

---

## Key Behaviors

### Room Management
- Rooms are created on first `join` and deleted when the last peer leaves
- Maximum 5 peers per room (enforced server-side)
- Peers are keyed by `peerId` string (UUID generated client-side)

### Validation
```js
if (!roomId || typeof roomId !== 'string' || roomId.length > 64)
if (!peerId || typeof peerId !== 'string' || peerId.length > 64)
```

Both `roomId` and `peerId` are validated: must be non-empty strings ≤ 64 characters.

### Message Routing
Offers, answers, and ICE candidates are routed to the peer identified by `msg.to`. The server does not interpret SDP or ICE — it only calls `targetWs.send(JSON.stringify(msg))`.

### Disconnect Cleanup
When a WebSocket closes:
1. The peer is removed from its room
2. `peer-left` is broadcast to remaining peers
3. The room is deleted if empty

---

## HTTP / Health Endpoint

The server exposes a lightweight HTTP server on the same port (`:8080`):

```
GET /health → 200 "ok"
```

This endpoint is used by the Playwright test runner to confirm the server is ready before tests start. All WebSocket traffic shares the same port via an HTTP upgrade.

---

## Running

```bash
cd server && node server.js
# or
cd server && npm run dev   # node --watch (hot reload)
```

---

## Tests

```bash
cd server && npx vitest@1.6.0 run server.test.js
```

| Test | What it verifies |
|---|---|
| `room-peers sent to newcomer` | Joining an existing room receives the peer list |
| `peer-joined broadcast` | Existing peers are notified when someone joins |
| `peer-left broadcast` | Peers are notified on disconnect |
| `room full rejected` | 6th peer receives `error: Room full` |
| `offer relay` | Offer is delivered to the target peer |
| `invalid roomId rejected` | Empty or oversized roomId gets an error response |
| `empty room cleanup` | Room is deleted when the last peer leaves |
| `answer relay` | Answer is delivered to the target peer |

---

## Files

| File | Role |
|---|---|
| `server/server.js` | Signaling server implementation |
| `server/server.test.js` | Vitest unit tests using mock WebSockets |
| `server/package.json` | `ws` dependency, `npm start` / `npm run dev` scripts |
