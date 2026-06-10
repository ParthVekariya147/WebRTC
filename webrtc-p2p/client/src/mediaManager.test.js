import { describe, it, expect, vi, beforeEach } from 'vitest';
import { getLocalStream, stopStream, MediaError } from './mediaManager.js';

// ── helpers ────────────────────────────────────────────────────────────────

function makeMockTrack(kind = 'video') {
    return { kind, enabled: true, stop: vi.fn() };
}

function makeStream(tracks = [makeMockTrack()]) {
    return {
        getTracks:      () => tracks,
        getVideoTracks: () => tracks.filter(t => t.kind === 'video'),
        getAudioTracks: () => tracks.filter(t => t.kind === 'audio'),
    };
}

function stubGetUserMedia(impl) {
    Object.defineProperty(global, 'navigator', {
        value: { mediaDevices: { getUserMedia: vi.fn(impl) } },
        configurable: true,
        writable: true,
    });
}

// ── getLocalStream() ────────────────────────────────────────────────────────

describe('getLocalStream() — constraints', () => {
    it('requests 720p video + echo-cancelled audio by default (front-cam constraints)', async () => {
        const mockFn = vi.fn(() => Promise.resolve(makeStream()));
        stubGetUserMedia(mockFn);

        await getLocalStream();

        const [constraints] = mockFn.mock.calls[0];
        // No facingMode → front-camera constraints (1280×720) to avoid crop/zoom on selfie sensors
        expect(constraints.video.width.ideal).toBe(1280);
        expect(constraints.video.height.ideal).toBe(720);
        expect(constraints.video.frameRate.ideal).toBe(30);
        expect(constraints.audio.echoCancellation).toBe(true);
        expect(constraints.audio.noiseSuppression).toBe(true);
    });

    it('requests 1080p video when facingMode targets rear camera', async () => {
        const mockFn = vi.fn(() => Promise.resolve(makeStream()));
        stubGetUserMedia(mockFn);

        await getLocalStream({ video: true, audio: false, facingMode: { ideal: 'environment' } });

        const [constraints] = mockFn.mock.calls[0];
        expect(constraints.video.width.ideal).toBe(1920);
        expect(constraints.video.height.ideal).toBe(1080);
    });

    it('omits video constraint when video: false', async () => {
        const mockFn = vi.fn(() => Promise.resolve(makeStream()));
        stubGetUserMedia(mockFn);

        await getLocalStream({ video: false, audio: true });

        const [constraints] = mockFn.mock.calls[0];
        expect(constraints.video).toBeUndefined();
        expect(constraints.audio).toBeDefined();
    });

    it('omits audio constraint when audio: false', async () => {
        const mockFn = vi.fn(() => Promise.resolve(makeStream()));
        stubGetUserMedia(mockFn);

        await getLocalStream({ video: true, audio: false });

        const [constraints] = mockFn.mock.calls[0];
        expect(constraints.audio).toBeUndefined();
        expect(constraints.video).toBeDefined();
    });

    it('returns the MediaStream on success', async () => {
        const stream = makeStream();
        stubGetUserMedia(() => Promise.resolve(stream));

        const result = await getLocalStream();
        expect(result).toBe(stream);
    });
});

describe('getLocalStream() — error mapping', () => {
    function domError(name) {
        return Object.assign(new Error(name), { name });
    }

    it('maps NotAllowedError → permission-denied MediaError', async () => {
        stubGetUserMedia(() => Promise.reject(domError('NotAllowedError')));
        await expect(getLocalStream()).rejects.toMatchObject({
            name: 'MediaError', type: 'permission-denied',
        });
    });

    it('maps PermissionDeniedError → permission-denied MediaError', async () => {
        stubGetUserMedia(() => Promise.reject(domError('PermissionDeniedError')));
        await expect(getLocalStream()).rejects.toMatchObject({
            name: 'MediaError', type: 'permission-denied',
        });
    });

    it('maps NotFoundError → not-found MediaError', async () => {
        stubGetUserMedia(() => Promise.reject(domError('NotFoundError')));
        await expect(getLocalStream()).rejects.toMatchObject({
            name: 'MediaError', type: 'not-found',
        });
    });

    it('maps DevicesNotFoundError → not-found MediaError', async () => {
        stubGetUserMedia(() => Promise.reject(domError('DevicesNotFoundError')));
        await expect(getLocalStream()).rejects.toMatchObject({
            name: 'MediaError', type: 'not-found',
        });
    });

    it('maps NotReadableError → in-use MediaError', async () => {
        stubGetUserMedia(() => Promise.reject(domError('NotReadableError')));
        await expect(getLocalStream()).rejects.toMatchObject({
            name: 'MediaError', type: 'in-use',
        });
    });

    it('maps TrackStartError → in-use MediaError', async () => {
        stubGetUserMedia(() => Promise.reject(domError('TrackStartError')));
        await expect(getLocalStream()).rejects.toMatchObject({
            name: 'MediaError', type: 'in-use',
        });
    });

    it('maps unknown DOMException → unknown MediaError', async () => {
        stubGetUserMedia(() => Promise.reject(domError('SomethingWeird')));
        await expect(getLocalStream()).rejects.toMatchObject({
            name: 'MediaError', type: 'unknown',
        });
    });

    it('MediaError message is never empty', async () => {
        stubGetUserMedia(() => Promise.reject(domError('NotAllowedError')));
        let err;
        try { await getLocalStream(); } catch (e) { err = e; }
        expect(err.message.length).toBeGreaterThan(0);
    });
});

// ── stopStream() ─────────────────────────────────────────────────────────────

describe('stopStream()', () => {
    it('calls stop() on every track', () => {
        const t1 = makeMockTrack('video');
        const t2 = makeMockTrack('audio');
        stopStream(makeStream([t1, t2]));
        expect(t1.stop).toHaveBeenCalledTimes(1);
        expect(t2.stop).toHaveBeenCalledTimes(1);
    });

    it('handles null gracefully', () => {
        expect(() => stopStream(null)).not.toThrow();
    });

    it('handles undefined gracefully', () => {
        expect(() => stopStream(undefined)).not.toThrow();
    });
});
