// PeerManager unit tests
// Mocks RTCPeerConnection, RTCSessionDescription, RTCIceCandidate so tests run
// in jsdom without a real browser WebRTC stack.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { PeerManager } from './peerManager.js';

// ── WebRTC mocks ───────────────────────────────────────────────────────────

class MockDataChannel {
    constructor(label) {
        this.label       = label;
        this.readyState  = 'open';
        this.binaryType  = 'blob';
        this.bufferedAmount = 0;
        this.bufferedAmountLowThreshold = 0;
        this.onopen      = null;
        this.onclose     = null;
        this.onmessage   = null;
        this._sent       = [];
    }
    send(data) { this._sent.push(data); }
    addEventListener(event, fn) { this['on' + event] = fn; }
    removeEventListener(event, fn) { if (this['on' + event] === fn) this['on' + event] = null; }
}

class MockRTCPeerConnection {
    static instances = [];

    constructor() {
        this.signalingState       = 'stable';
        this.remoteDescription    = null;
        this.localDescription     = null;
        this.iceConnectionState   = 'new';
        this._closed              = false;
        this._addedIceCandidates  = [];
        this.onicecandidate              = null;
        this.ondatachannel               = null;
        this.oniceconnectionstatechange  = null;
        this.onnegotiationneeded         = null;
        this.ontrack                     = null;
        MockRTCPeerConnection.instances.push(this);
    }

    async createOffer()  { return { type: 'offer',  sdp: 'mock-offer-sdp'  }; }
    async createAnswer() { return { type: 'answer', sdp: 'mock-answer-sdp' }; }

    async setLocalDescription(desc) {
        this.localDescription = desc;
        const t = desc?.type;
        if (!t || t === 'rollback')    this.signalingState = 'stable';
        else if (t === 'offer')        this.signalingState = 'have-local-offer';
        else if (t === 'answer')       this.signalingState = 'stable';
    }

    async setRemoteDescription(desc) {
        this.remoteDescription = desc;
        const t = desc?.type;
        if (t === 'offer')  this.signalingState = 'have-remote-offer';
        else if (t === 'answer') this.signalingState = 'stable';
    }

    async addIceCandidate(c) { this._addedIceCandidates.push(c); }

    createDataChannel(label) { return new MockDataChannel(label); }

    addTrack() {}
    getTransceivers() { return []; }
    close() { this._closed = true; this.signalingState = 'closed'; }
}

class MockRTCSessionDescription {
    constructor(init) { Object.assign(this, init); }
}

class MockRTCIceCandidate {
    constructor(init) { Object.assign(this, init); }
}

// ── Signaling stub ─────────────────────────────────────────────────────────

function makeSignaling(localId = 'alice') {
    const listeners = {};
    const stub = {
        localId,
        offers:   [],
        answers:  [],
        ices:     [],
        sendOffer(to, from, sdp)   { stub.offers.push({ to, from, sdp }); },
        sendAnswer(to, from, sdp)  { stub.answers.push({ to, from, sdp }); },
        sendIce(to, from, cand)    { stub.ices.push({ to, from, cand }); },
        addEventListener(type, fn) {
            listeners[type] = listeners[type] || [];
            listeners[type].push(fn);
        },
        // Simulate server events
        emit(type, detail) {
            (listeners[type] || []).forEach(fn => fn({ type, detail }));
        },
    };
    return stub;
}

// ── Setup / teardown ───────────────────────────────────────────────────────

beforeEach(() => {
    MockRTCPeerConnection.instances = [];
    vi.stubGlobal('RTCPeerConnection',       MockRTCPeerConnection);
    vi.stubGlobal('RTCSessionDescription',   MockRTCSessionDescription);
    vi.stubGlobal('RTCIceCandidate',         MockRTCIceCandidate);
});
afterEach(() => {
    vi.unstubAllGlobals();
});

function latestPc() {
    return MockRTCPeerConnection.instances[MockRTCPeerConnection.instances.length - 1];
}

// Flush all pending microtasks (Promises) by yielding to the macrotask queue.
// A single `await Promise.resolve()` only advances one microtask level; the
// async methods here chain 4+ awaits, so we need to drain the entire queue.
const flush = () => new Promise(r => setTimeout(r, 0));

// ── Tests ──────────────────────────────────────────────────────────────────

describe('PeerManager — room-peers / peer-joined', () => {
    it('creates an offer for each peer listed in room-peers', async () => {
        const sig = makeSignaling('alice');
        const pm  = new PeerManager('alice', sig);

        sig.emit('room-peers', { peers: ['bob', 'carol'] });
        await flush();

        expect(sig.offers).toHaveLength(2);
        expect(sig.offers.map(o => o.to)).toEqual(expect.arrayContaining(['bob', 'carol']));
    });

    it('does NOT create a duplicate offer for a peer already connected (H4 fix)', async () => {
        const sig = makeSignaling('alice');
        const pm  = new PeerManager('alice', sig);

        sig.emit('room-peers', { peers: ['bob'] });
        await flush();
        const offerCountAfterFirst = sig.offers.length;

        // Simulate reconnect: room-peers fires again with same peers
        sig.emit('room-peers', { peers: ['bob'] });
        await flush();

        expect(sig.offers.length).toBe(offerCountAfterFirst); // no extra offer
    });

    it('prepares a connection (no offer) when peer-joined fires', () => {
        const sig = makeSignaling('alice');
        const pm  = new PeerManager('alice', sig);

        sig.emit('peer-joined', { peerId: 'bob' });

        expect(pm.connections.has('bob')).toBe(true);
        expect(sig.offers).toHaveLength(0); // answerer side, no offer
    });
});

describe('PeerManager — offer/answer flow', () => {
    it('answers an incoming offer and sends an answer', async () => {
        const sig = makeSignaling('alice');
        const pm  = new PeerManager('alice', sig);

        sig.emit('peer-joined', { peerId: 'bob' });
        sig.emit('offer', { from: 'bob', sdp: { type: 'offer', sdp: 'mock' } });
        await flush();

        expect(sig.answers.length).toBeGreaterThan(0);
        expect(sig.answers[0].to).toBe('bob');
    });

    it('ignores a stale answer when PC is already stable', async () => {
        const sig = makeSignaling('alice');
        const pm  = new PeerManager('alice', sig);

        sig.emit('room-peers', { peers: ['bob'] });
        await Promise.resolve();

        const pc = MockRTCPeerConnection.instances.find(p => !p._closed);
        // Force stable state before the answer arrives
        pc.signalingState = 'stable';
        await pc.setRemoteDescription({ type: 'answer', sdp: 'late' });

        const setRemoteSpy = vi.spyOn(pc, 'setRemoteDescription');
        sig.emit('answer', { from: 'bob', sdp: { type: 'answer', sdp: 'stale' } });
        await Promise.resolve();

        // setRemoteDescription should not be called again
        expect(setRemoteSpy).not.toHaveBeenCalled();
    });
});

describe('PeerManager — ICE candidate queuing (D2)', () => {
    it('queues ICE candidates that arrive before setRemoteDescription', async () => {
        const sig = makeSignaling('alice');
        const pm  = new PeerManager('alice', sig);

        sig.emit('peer-joined', { peerId: 'bob' });

        // ICE arrives before offer — should be queued, not applied immediately
        sig.emit('ice-candidate', { from: 'bob', candidate: { candidate: 'cand1' } });

        const pc = pm.connections.get('bob');
        // No remoteDescription yet → candidate should be in the queue
        expect(pc._addedIceCandidates).toHaveLength(0);
        expect(pm._pendingCandidates.get('bob')).toHaveLength(1);
    });

    it('drains the ICE queue after offer is processed', async () => {
        const sig = makeSignaling('alice');
        const pm  = new PeerManager('alice', sig);

        sig.emit('peer-joined', { peerId: 'bob' });
        sig.emit('ice-candidate', { from: 'bob', candidate: { candidate: 'cand1' } });
        sig.emit('offer', { from: 'bob', sdp: { type: 'offer', sdp: 'mock' } });
        await flush();

        const pc = pm.connections.get('bob');
        expect(pc._addedIceCandidates).toHaveLength(1);
        expect(pm._pendingCandidates.get('bob')).toHaveLength(0);
    });

    it('caps the pending candidates queue at 100 (H5 fix)', async () => {
        const sig = makeSignaling('alice');
        const pm  = new PeerManager('alice', sig);

        sig.emit('peer-joined', { peerId: 'bob' });

        for (let i = 0; i < 200; i++) {
            sig.emit('ice-candidate', { from: 'bob', candidate: { candidate: `cand${i}` } });
        }

        expect(pm._pendingCandidates.get('bob').length).toBeLessThanOrEqual(100);
    });
});

describe('PeerManager — perfect negotiation (glare)', () => {
    it('impolite peer ignores colliding offer', async () => {
        // 'bob' > 'alice' lexicographically → bob is impolite
        const sig = makeSignaling('bob');
        const pm  = new PeerManager('bob', sig);

        sig.emit('peer-joined', { peerId: 'alice' });
        // Simulate bob is currently making an offer
        pm._makingOffer.set('alice', true);

        const pc = pm.connections.get('alice');
        const setRemoteSpy = vi.spyOn(pc, 'setRemoteDescription');

        // Incoming offer from alice during collision
        sig.emit('offer', { from: 'alice', sdp: { type: 'offer', sdp: 'mock' } });
        await flush();

        // Impolite bob should have ignored it
        expect(setRemoteSpy).not.toHaveBeenCalled();
        expect(sig.answers).toHaveLength(0);
    });

    it('polite peer rolls back and accepts colliding offer', async () => {
        // 'alice' < 'bob' → alice is polite
        const sig = makeSignaling('alice');
        const pm  = new PeerManager('alice', sig);

        sig.emit('peer-joined', { peerId: 'bob' });
        pm._makingOffer.set('bob', true);

        const pc = pm.connections.get('bob');
        pc.signalingState = 'have-local-offer'; // simulating we already sent an offer

        sig.emit('offer', { from: 'bob', sdp: { type: 'offer', sdp: 'mock' } });
        await flush();

        // Polite alice rolls back then accepts → should send an answer
        expect(sig.answers.length).toBeGreaterThan(0);
    });
});

describe('PeerManager — peer cleanup', () => {
    it('cleans up all state when peer-left fires', () => {
        const sig = makeSignaling('alice');
        const pm  = new PeerManager('alice', sig);

        sig.emit('peer-joined', { peerId: 'bob' });
        expect(pm.connections.has('bob')).toBe(true);

        sig.emit('peer-left', { peerId: 'bob' });

        expect(pm.connections.has('bob')).toBe(false);
        expect(pm.channels.has('bob')).toBe(false);
        expect(pm._pendingCandidates.has('bob')).toBe(false);
        expect(pm._makingOffer.has('bob')).toBe(false);
    });

    it('closes the RTCPeerConnection on peer-left', () => {
        const sig = makeSignaling('alice');
        const pm  = new PeerManager('alice', sig);

        sig.emit('peer-joined', { peerId: 'bob' });
        const pc = pm.connections.get('bob');

        sig.emit('peer-left', { peerId: 'bob' });

        expect(pc._closed).toBe(true);
    });

    it('dispatches peerleft CustomEvent', () => {
        const sig = makeSignaling('alice');
        const pm  = new PeerManager('alice', sig);

        sig.emit('peer-joined', { peerId: 'bob' });

        const events = [];
        pm.addEventListener('peerleft', (e) => events.push(e.detail));
        sig.emit('peer-left', { peerId: 'bob' });

        expect(events).toHaveLength(1);
        expect(events[0].peerId).toBe('bob');
    });

    it('destroy() closes all connections and clears all maps', async () => {
        const sig = makeSignaling('alice');
        const pm  = new PeerManager('alice', sig);

        sig.emit('room-peers', { peers: ['bob', 'carol'] });
        await flush();

        pm.destroy();

        expect(pm.connections.size).toBe(0);
        expect(pm.channels.size).toBe(0);
        expect(MockRTCPeerConnection.instances.every(pc => pc._closed)).toBe(true);
    });
});

describe('PeerManager — safeSend', () => {
    it('returns false when channel does not exist for peer', () => {
        const sig = makeSignaling('alice');
        const pm  = new PeerManager('alice', sig);

        expect(pm.safeSend('bob', 'chat', 'hello')).toBe(false);
    });

    it('returns false when channel is not open', async () => {
        const sig = makeSignaling('alice');
        const pm  = new PeerManager('alice', sig);

        sig.emit('room-peers', { peers: ['bob'] });
        await flush();

        // Force chat channel to closed state
        const chatChannel = pm.getChannel('bob', 'chat');
        if (chatChannel) chatChannel.readyState = 'closed';

        expect(pm.safeSend('bob', 'chat', 'hello')).toBe(false);
    });
});

// ── setLocalStream() — Phase 5A video track wiring ────────────────────────

describe('PeerManager — setLocalStream()', () => {
    // Shared mock function assigned to the prototype so all instances use it.
    // Count calls on THIS reference — do not reduce per-instance (they all point
    // to the same fn, so per-instance counts would double-count).
    let addTrackMock;
    beforeEach(() => {
        addTrackMock = vi.fn();
        MockRTCPeerConnection.prototype.addTrack = addTrackMock;
    });

    it('stores the stream and adds tracks to all existing connections', async () => {
        const sig = makeSignaling('alice');
        const pm  = new PeerManager('alice', sig);

        sig.emit('room-peers', { peers: ['bob', 'carol'] });
        await flush();

        const stream = { getTracks: () => [{ kind: 'video' }, { kind: 'audio' }] };
        pm.setLocalStream(stream);

        expect(pm.localStream).toBe(stream);
        // 2 peers × 2 tracks = 4 addTrack calls
        expect(addTrackMock).toHaveBeenCalledTimes(4);
    });

    it('new connections created after setLocalStream get tracks immediately', async () => {
        const sig = makeSignaling('alice');
        const pm  = new PeerManager('alice', sig);

        const stream = { getTracks: () => [{ kind: 'video' }, { kind: 'audio' }] };
        pm.setLocalStream(stream);

        // New peer joins AFTER stream is set — _createPeerConnection sees localStream
        sig.emit('room-peers', { peers: ['bob'] });
        await flush();

        // 1 peer × 2 tracks = 2 addTrack calls
        expect(addTrackMock).toHaveBeenCalledTimes(2);
    });

    it('setLocalStream(null) clears the stream without throwing', async () => {
        const sig = makeSignaling('alice');
        const pm  = new PeerManager('alice', sig);

        const stream = { getTracks: () => [] };
        pm.setLocalStream(stream);
        expect(() => pm.setLocalStream(null)).not.toThrow();
        expect(pm.localStream).toBeNull();
    });
});
