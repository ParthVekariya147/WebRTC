// Phase 1 exit-criteria tests — signaling server
// Covers every requirement from the development plan Phase 1 exit test:
//   1. Newcomer receives room-peers list
//   2. Existing peers get peer-joined notification
//   3. Closing a tab fires peer-left to everyone else
//   4. Server refuses a 6th peer with 'error: Room full'
//   + roomId/peerId validation
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import WebSocket, { WebSocketServer } from 'ws';

const TEST_PORT = 19090;

// ── Minimal inline server (mirrors server.js logic, avoids import side-effects) ──
function makeServer(port) {
    const rooms = new Map();
    const wss = new WebSocketServer({ port });

    wss.on('connection', (ws) => {
        let currentRoom = null;
        let currentPeerId = null;

        ws.on('message', (raw) => {
            let msg;
            try { msg = JSON.parse(raw); } catch { return; }

            if (msg.type === 'join') {
                const { roomId, peerId } = msg;
                if (!roomId || typeof roomId !== 'string' || roomId.length > 64) {
                    ws.send(JSON.stringify({ type: 'error', message: 'Invalid roomId' })); return;
                }
                if (!peerId || typeof peerId !== 'string' || peerId.length > 64) {
                    ws.send(JSON.stringify({ type: 'error', message: 'Invalid peerId' })); return;
                }
                // Reject duplicate peerId (H2)
                if (rooms.has(roomId) && rooms.get(roomId).has(peerId)) {
                    ws.send(JSON.stringify({ type: 'error', message: 'Peer ID already in use' })); return;
                }
                if (!rooms.has(roomId)) rooms.set(roomId, new Map());
                const room = rooms.get(roomId);
                if (room.size >= 5) {
                    ws.send(JSON.stringify({ type: 'error', message: 'Room full' })); return;
                }
                ws.send(JSON.stringify({ type: 'room-peers', peers: Array.from(room.keys()) }));
                room.forEach((peerWs) => {
                    if (peerWs.readyState === WebSocket.OPEN)
                        peerWs.send(JSON.stringify({ type: 'peer-joined', peerId }));
                });
                room.set(peerId, ws);
                currentRoom = roomId; currentPeerId = peerId;
                return;
            }
            if (['offer', 'answer', 'ice-candidate'].includes(msg.type)) {
                if (!currentRoom) return;
                const room = rooms.get(currentRoom);
                if (!room) return;
                const target = room.get(msg.to);
                if (target && target.readyState === WebSocket.OPEN) {
                    // Overwrite from with authenticated sender ID (H1)
                    msg.from = currentPeerId;
                    target.send(JSON.stringify(msg));
                }
            }
        });

        ws.on('close', () => {
            if (!currentRoom || !currentPeerId) return;
            const room = rooms.get(currentRoom);
            if (!room) return;
            room.delete(currentPeerId);
            if (room.size === 0) rooms.delete(currentRoom);
            room.forEach((peerWs) => {
                if (peerWs.readyState === WebSocket.OPEN)
                    peerWs.send(JSON.stringify({ type: 'peer-left', peerId: currentPeerId }));
            });
        });
    });
    return { wss, rooms };
}

// ── Helpers ──
function connect(port = TEST_PORT) {
    return new Promise((resolve, reject) => {
        const ws = new WebSocket(`ws://localhost:${port}`);
        ws.on('open', () => resolve(ws));
        ws.on('error', reject);
    });
}

function nextMsg(ws, type) {
    return new Promise((resolve) => {
        const handler = (raw) => {
            const msg = JSON.parse(raw);
            if (msg.type === type) { ws.off('message', handler); resolve(msg); }
        };
        ws.on('message', handler);
    });
}

function closeWait(ws) {
    return new Promise((resolve) => {
        if (ws.readyState === WebSocket.CLOSED) { resolve(); return; }
        ws.on('close', resolve);
        ws.close();
    });
}

// ── Tests ──
let server;
beforeEach(() => { server = makeServer(TEST_PORT); });
afterEach(() => new Promise((resolve) => { server.wss.close(resolve); }));

describe('Phase 1 — Signaling server', () => {

    // Exit test requirement 1: newcomer receives existing peer list
    it('sends room-peers [] to the first joiner', async () => {
        const ws = await connect();
        ws.send(JSON.stringify({ type: 'join', roomId: 'room1', peerId: 'peer-a' }));
        const msg = await nextMsg(ws, 'room-peers');
        expect(msg.peers).toEqual([]);
        await closeWait(ws);
    });

    // Exit test requirement 2a: second peer sees existing list
    it('sends room-peers [peer-a] to second joiner', async () => {
        const wsA = await connect();
        wsA.send(JSON.stringify({ type: 'join', roomId: 'room2', peerId: 'peer-a' }));
        await nextMsg(wsA, 'room-peers');

        const wsB = await connect();
        wsB.send(JSON.stringify({ type: 'join', roomId: 'room2', peerId: 'peer-b' }));
        const msg = await nextMsg(wsB, 'room-peers');
        expect(msg.peers).toContain('peer-a');
        await Promise.all([closeWait(wsA), closeWait(wsB)]);
    });

    // Exit test requirement 2b: existing peer gets peer-joined notification
    it('notifies existing peer when second peer joins', async () => {
        const wsA = await connect();
        wsA.send(JSON.stringify({ type: 'join', roomId: 'room3', peerId: 'peer-a' }));
        await nextMsg(wsA, 'room-peers');

        const wsB = await connect();
        wsB.send(JSON.stringify({ type: 'join', roomId: 'room3', peerId: 'peer-b' }));

        const [joined] = await Promise.all([
            nextMsg(wsA, 'peer-joined'),
            nextMsg(wsB, 'room-peers'),
        ]);
        expect(joined.peerId).toBe('peer-b');
        await Promise.all([closeWait(wsA), closeWait(wsB)]);
    });

    // Exit test requirement 3: closing a tab fires peer-left
    it('broadcasts peer-left when a peer disconnects', async () => {
        const wsA = await connect();
        wsA.send(JSON.stringify({ type: 'join', roomId: 'room4', peerId: 'peer-a' }));
        await nextMsg(wsA, 'room-peers');

        const wsB = await connect();
        wsB.send(JSON.stringify({ type: 'join', roomId: 'room4', peerId: 'peer-b' }));
        await Promise.all([nextMsg(wsA, 'peer-joined'), nextMsg(wsB, 'room-peers')]);

        const leftPromise = nextMsg(wsA, 'peer-left');
        await closeWait(wsB);
        const left = await leftPromise;
        expect(left.peerId).toBe('peer-b');
        await closeWait(wsA);
    });

    // Exit test requirement 4: server refuses 6th peer
    it('refuses a 6th peer with "Room full"', async () => {
        const peers = [];
        for (let i = 0; i < 5; i++) {
            const ws = await connect();
            ws.send(JSON.stringify({ type: 'join', roomId: 'full-room', peerId: `peer-${i}` }));
            await nextMsg(ws, 'room-peers');
            peers.push(ws);
        }
        const ws6 = await connect();
        ws6.send(JSON.stringify({ type: 'join', roomId: 'full-room', peerId: 'peer-6' }));
        const err = await nextMsg(ws6, 'error');
        expect(err.message).toBe('Room full');
        await Promise.all([...peers.map(closeWait), closeWait(ws6)]);
    });

    // Bonus: relay offer/answer/ice-candidate between peers
    it('relays offer from peer-a to peer-b', async () => {
        const wsA = await connect();
        wsA.send(JSON.stringify({ type: 'join', roomId: 'relay-room', peerId: 'peer-a' }));
        await nextMsg(wsA, 'room-peers');

        const wsB = await connect();
        wsB.send(JSON.stringify({ type: 'join', roomId: 'relay-room', peerId: 'peer-b' }));
        await Promise.all([nextMsg(wsA, 'peer-joined'), nextMsg(wsB, 'room-peers')]);

        wsA.send(JSON.stringify({ type: 'offer', to: 'peer-b', from: 'peer-a', sdp: { type: 'offer', sdp: 'v=0...' } }));
        const relayed = await nextMsg(wsB, 'offer');
        expect(relayed.from).toBe('peer-a');
        expect(relayed.sdp.type).toBe('offer');
        await Promise.all([closeWait(wsA), closeWait(wsB)]);
    });

    // Validation
    it('rejects empty roomId', async () => {
        const ws = await connect();
        ws.send(JSON.stringify({ type: 'join', roomId: '', peerId: 'peer-a' }));
        const err = await nextMsg(ws, 'error');
        expect(err.message).toMatch(/Invalid roomId/);
        await closeWait(ws);
    });

    it('cleans up empty room after last peer leaves', async () => {
        const ws = await connect();
        ws.send(JSON.stringify({ type: 'join', roomId: 'cleanup-room', peerId: 'peer-a' }));
        await nextMsg(ws, 'room-peers');
        await closeWait(ws);
        // Give server a tick to process close
        await new Promise(r => setTimeout(r, 50));
        expect(server.rooms.has('cleanup-room')).toBe(false);
    });

    // ── Security tests ──────────────────────────────────────────────────────

    // H1: server must overwrite the 'from' field so clients cannot impersonate each other
    it('overwrites from field with authenticated sender peerId (H1 — peer impersonation)', async () => {
        const wsA = await connect();
        wsA.send(JSON.stringify({ type: 'join', roomId: 'sec-room1', peerId: 'alice' }));
        await nextMsg(wsA, 'room-peers');

        const wsB = await connect();
        wsB.send(JSON.stringify({ type: 'join', roomId: 'sec-room1', peerId: 'bob' }));
        await Promise.all([nextMsg(wsA, 'peer-joined'), nextMsg(wsB, 'room-peers')]);

        // Bob sends an offer claiming to be from 'carol' (spoofed from field)
        wsB.send(JSON.stringify({ type: 'offer', to: 'alice', from: 'carol', sdp: {} }));

        const relayed = await nextMsg(wsA, 'offer');
        // Server must have overwritten 'from' with bob's actual peerId
        expect(relayed.from).toBe('bob');
        expect(relayed.from).not.toBe('carol');

        await Promise.all([closeWait(wsA), closeWait(wsB)]);
    });

    // H2: reject duplicate peerId to prevent peer-left ghost attacks
    it('rejects a duplicate peerId in the same room (H2)', async () => {
        const wsA = await connect();
        wsA.send(JSON.stringify({ type: 'join', roomId: 'dup-room', peerId: 'peer-a' }));
        await nextMsg(wsA, 'room-peers');

        const wsB = await connect();
        wsB.send(JSON.stringify({ type: 'join', roomId: 'dup-room', peerId: 'peer-a' })); // same ID
        const err = await nextMsg(wsB, 'error');
        expect(err.message).toMatch(/already in use/);

        await Promise.all([closeWait(wsA), closeWait(wsB)]);
    });
});
