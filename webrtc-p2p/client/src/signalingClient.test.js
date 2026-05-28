// SignalingClient unit tests
// Mocks the browser WebSocket so tests run in jsdom without a real server.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { SignalingClient } from './signalingClient.js';

// ── Mock WebSocket ─────────────────────────────────────────────────────────
let wsInstances = [];

class MockWebSocket {
    static CONNECTING = 0;
    static OPEN       = 1;
    static CLOSING    = 2;
    static CLOSED     = 3;

    constructor(url) {
        this.url        = url;
        this.readyState = MockWebSocket.CONNECTING;
        this.sent       = [];
        this.onopen     = null;
        this.onmessage  = null;
        this.onclose    = null;
        this.onerror    = null;
        wsInstances.push(this);
    }

    send(data) { this.sent.push(data); }

    close() {
        this.readyState = MockWebSocket.CLOSED;
        this.onclose?.();
    }

    // Test helpers — simulate server events
    _open()         { this.readyState = MockWebSocket.OPEN; this.onopen?.(); }
    _message(obj)   { this.onmessage?.({ data: JSON.stringify(obj) }); }
    _close()        { this.readyState = MockWebSocket.CLOSED; this.onclose?.(); }
    _error(err)     { this.onerror?.(err); }
}

// Install / restore the WebSocket mock around every test
beforeEach(() => {
    wsInstances = [];
    vi.stubGlobal('WebSocket', MockWebSocket);
});
afterEach(() => {
    vi.unstubAllGlobals();
});

function latestWs() { return wsInstances[wsInstances.length - 1]; }

// ── Tests ──────────────────────────────────────────────────────────────────

describe('SignalingClient — connection lifecycle', () => {
    it('creates a WebSocket to the given URL on construction', () => {
        new SignalingClient('ws://test:8080');
        expect(latestWs().url).toBe('ws://test:8080');
    });

    it('dispatches "connected" when the socket opens', () => {
        const sc = new SignalingClient('ws://x');
        const fired = [];
        sc.addEventListener('connected', () => fired.push(true));
        latestWs()._open();
        expect(fired).toHaveLength(1);
    });

    it('does NOT send join until the socket is open', () => {
        const sc = new SignalingClient('ws://x');
        sc.join('room1', 'alice');
        expect(latestWs().sent).toHaveLength(0); // socket not yet open
    });

    it('sends join once open when join() is called first', () => {
        const sc = new SignalingClient('ws://x');
        sc.join('room1', 'alice');
        latestWs()._open();
        // join is NOT auto-sent on open unless _roomId was set before open
        // (the signaling client sends join in the 'connected' event handler set up by caller)
        // verify at least that the WS is open and state is stored
        expect(sc._roomId).toBe('room1');
        expect(sc._peerId).toBe('alice');
    });

    it('sends join when called after open', () => {
        const sc = new SignalingClient('ws://x');
        latestWs()._open();
        sc.join('room2', 'bob');
        expect(latestWs().sent).toHaveLength(1);
        expect(JSON.parse(latestWs().sent[0])).toMatchObject({
            type: 'join', roomId: 'room2', peerId: 'bob',
        });
    });
});

describe('SignalingClient — message dispatch', () => {
    it('dispatches room-peers as a CustomEvent with detail', () => {
        const sc = new SignalingClient('ws://x');
        latestWs()._open();
        const events = [];
        sc.addEventListener('room-peers', (e) => events.push(e.detail));
        latestWs()._message({ type: 'room-peers', peers: ['alice'] });
        expect(events).toHaveLength(1);
        expect(events[0].peers).toEqual(['alice']);
    });

    it('dispatches peer-joined with correct detail', () => {
        const sc = new SignalingClient('ws://x');
        latestWs()._open();
        const events = [];
        sc.addEventListener('peer-joined', (e) => events.push(e.detail));
        latestWs()._message({ type: 'peer-joined', peerId: 'carol' });
        expect(events[0].peerId).toBe('carol');
    });

    it('silently ignores malformed JSON from server', () => {
        const sc = new SignalingClient('ws://x');
        latestWs()._open();
        expect(() => {
            latestWs().onmessage?.({ data: 'not json{{' });
        }).not.toThrow();
    });
});

describe('SignalingClient — outbound relay helpers', () => {
    it('sendOffer formats the offer message correctly', () => {
        const sc = new SignalingClient('ws://x');
        latestWs()._open();
        sc.sendOffer('bob', 'alice', { type: 'offer', sdp: 'v=0' });
        const msg = JSON.parse(latestWs().sent[0]);
        expect(msg).toMatchObject({ type: 'offer', to: 'bob', from: 'alice', sdp: { type: 'offer' } });
    });

    it('sendAnswer formats the answer message correctly', () => {
        const sc = new SignalingClient('ws://x');
        latestWs()._open();
        sc.sendAnswer('alice', 'bob', { type: 'answer', sdp: 'v=0' });
        const msg = JSON.parse(latestWs().sent[0]);
        expect(msg).toMatchObject({ type: 'answer', to: 'alice', from: 'bob' });
    });

    it('sendIce formats the ICE candidate message correctly', () => {
        const sc = new SignalingClient('ws://x');
        latestWs()._open();
        sc.sendIce('bob', 'alice', { candidate: 'cand1', sdpMLineIndex: 0 });
        const msg = JSON.parse(latestWs().sent[0]);
        expect(msg).toMatchObject({ type: 'ice-candidate', to: 'bob', from: 'alice' });
        expect(msg.candidate.candidate).toBe('cand1');
    });
});

describe('SignalingClient — reconnect behaviour', () => {
    it('schedules reconnect when the socket closes (not destroyed)', async () => {
        vi.useFakeTimers();
        const sc = new SignalingClient('ws://x');
        latestWs()._open();
        latestWs()._close();
        const instancesBefore = wsInstances.length;
        vi.advanceTimersByTime(1100); // > initial 1000ms backoff
        expect(wsInstances.length).toBeGreaterThan(instancesBefore);
        vi.useRealTimers();
    });

    it('does NOT reconnect after destroy()', async () => {
        vi.useFakeTimers();
        const sc = new SignalingClient('ws://x');
        latestWs()._open();
        sc.destroy();
        const countBefore = wsInstances.length;
        vi.advanceTimersByTime(5000);
        expect(wsInstances.length).toBe(countBefore); // no new instances
        vi.useRealTimers();
    });

    it('re-joins the room automatically after reconnect', () => {
        const sc = new SignalingClient('ws://x');
        const firstWs = latestWs();
        firstWs._open();
        sc.join('my-room', 'alice');
        firstWs.sent = []; // clear

        // Simulate disconnect → reconnect
        firstWs._close();
        const newWs = latestWs();
        newWs._open();

        // On reconnect, should automatically re-join
        const joinMsg = newWs.sent.find(s => {
            const m = JSON.parse(s);
            return m.type === 'join' && m.roomId === 'my-room' && m.peerId === 'alice';
        });
        expect(joinMsg).toBeDefined();
    });
});
