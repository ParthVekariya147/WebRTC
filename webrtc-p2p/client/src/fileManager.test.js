import { describe, it, expect, vi, beforeEach } from 'vitest';
import { FileManager } from './fileManager.js';

// Minimal PeerManager stub
function makePeerManager() {
  const listeners = {};
  const sent = []; // { peerId, label, data }
  // Stub DataChannel returned by getChannel — bufferedAmount=0 so back-pressure
  // never triggers in unit tests (the real path is tested in E2E).
  const stubChannel = { readyState: 'open', bufferedAmount: 0, addEventListener() {}, removeEventListener() {} };

  return {
    sent,
    safeSend(peerId, label, data) {
      sent.push({ peerId, label, data });
      return true;
    },
    getChannel(peerId, label) {
      return stubChannel;
    },
    addEventListener(event, handler) {
      listeners[event] = listeners[event] || [];
      listeners[event].push(handler);
    },
    emit(event, detail) {
      (listeners[event] || []).forEach((h) => h({ detail }));
    },
  };
}

function makeFile(content, name = 'test.txt', mime = 'text/plain') {
  return new File([content], name, { type: mime });
}

// ── Chunking helpers ────────────────────────────────────────────────────────

describe('FileManager — encoding/decoding round-trip', () => {
  it('sends file-start JSON then binary chunks then file-end JSON', async () => {
    const pm = makePeerManager();
    const fm = new FileManager(pm);
    const content = 'Hello, World!';
    const file = makeFile(content);

    await fm.sendFile('peer-b', file);

    const frames = pm.sent;
    expect(frames.length).toBeGreaterThanOrEqual(3);

    // First frame: file-start JSON
    const start = JSON.parse(frames[0].data);
    expect(start.type).toBe('file-start');
    expect(start.name).toBe('test.txt');
    expect(start.size).toBe(content.length);
    expect(start.totalChunks).toBe(1); // small file → 1 chunk

    // Middle frame: ArrayBuffer binary chunk
    expect(frames[1].data).toBeInstanceOf(ArrayBuffer);

    // Last frame: file-end JSON
    const end = JSON.parse(frames[frames.length - 1].data);
    expect(end.type).toBe('file-end');
    expect(end.id).toBe(start.id);
  });

  it('splits large content into multiple chunks', async () => {
    const pm = makePeerManager();
    const fm = new FileManager(pm);
    // 33 KB → 3 chunks at 16 KB each
    const big = new Uint8Array(33 * 1024).fill(0x42);
    const file = new File([big], 'big.bin', { type: 'application/octet-stream' });

    await fm.sendFile('peer-b', file);

    const binaryFrames = pm.sent.filter((f) => f.data instanceof ArrayBuffer);
    expect(binaryFrames.length).toBe(3);
  });
});

// ── Progress events ─────────────────────────────────────────────────────────

describe('FileManager — sender progress events', () => {
  it('emits one progress event per chunk sent', async () => {
    const pm = makePeerManager();
    const fm = new FileManager(pm);
    const progressEvents = [];
    fm.addEventListener('progress', (e) => progressEvents.push(e.detail));

    const big = new Uint8Array(33 * 1024).fill(0xff);
    const file = new File([big], 'data.bin');
    await fm.sendFile('peer-b', file);

    expect(progressEvents.length).toBe(3);
    expect(progressEvents[0].sent).toBe(1);
    expect(progressEvents[2].sent).toBe(3);
    expect(progressEvents[2].total).toBe(3);
  });
});

// ── Receive + reassembly ────────────────────────────────────────────────────

describe('FileManager — receiver reassembly', () => {
  it('reassembles single-chunk transfer and emits file-received', async () => {
    const pm = makePeerManager();
    const fmSender = new FileManager(pm);
    const pmReceiver = makePeerManager();
    const fmReceiver = new FileManager(pmReceiver);

    const received = [];
    fmReceiver.addEventListener('file-received', (e) => received.push(e.detail));

    const content = 'Ping from sender';
    const file = makeFile(content);
    await fmSender.sendFile('peer-b', file);

    // Replay all frames into receiver as if they came from 'peer-a'
    for (const frame of pm.sent) {
      pmReceiver.emit('message', { peerId: 'peer-a', label: 'file', data: frame.data });
    }

    expect(received.length).toBe(1);
    expect(received[0].name).toBe('test.txt');
    expect(received[0].blob).toBeInstanceOf(Blob);
    expect(received[0].blob.size).toBe(content.length);
  });

  it('reassembles multi-chunk transfer correctly', async () => {
    const pm = makePeerManager();
    const fmSender = new FileManager(pm);
    const pmReceiver = makePeerManager();
    const fmReceiver = new FileManager(pmReceiver);

    const received = [];
    fmReceiver.addEventListener('file-received', (e) => received.push(e.detail));

    const big = new Uint8Array(40 * 1024);
    for (let i = 0; i < big.length; i++) big[i] = i & 0xff;
    const file = new File([big], 'chunk-test.bin', { type: 'application/octet-stream' });
    await fmSender.sendFile('peer-b', file);

    for (const frame of pm.sent) {
      pmReceiver.emit('message', { peerId: 'peer-a', label: 'file', data: frame.data });
    }

    expect(received.length).toBe(1);
    expect(received[0].blob.size).toBe(40 * 1024);
    expect(received[0].mime).toBe('application/octet-stream');
  });

  it('emits transfer-start before any chunks', async () => {
    const pm = makePeerManager();
    const fmSender = new FileManager(pm);
    const pmReceiver = makePeerManager();
    const fmReceiver = new FileManager(pmReceiver);

    const starts = [];
    fmReceiver.addEventListener('transfer-start', (e) => starts.push(e.detail));

    await fmSender.sendFile('peer-b', makeFile('abc'));
    for (const frame of pm.sent) {
      pmReceiver.emit('message', { peerId: 'peer-a', label: 'file', data: frame.data });
    }

    expect(starts.length).toBe(1);
    expect(starts[0].name).toBe('test.txt');
    expect(starts[0].size).toBe(3);
  });

  it('ignores chunks for unknown transfer ids', () => {
    const pm = makePeerManager();
    const fm = new FileManager(pm);
    const received = [];
    fm.addEventListener('file-received', (e) => received.push(e.detail));

    // Send a random binary blob that doesn't match any known transfer
    const fakeChunk = new ArrayBuffer(20);
    pm.emit('message', { peerId: 'peer-a', label: 'file', data: fakeChunk });

    expect(received.length).toBe(0);
  });
});

// ── Peer disconnect ─────────────────────────────────────────────────────────

describe('FileManager — peerLeft cleanup', () => {
  it('emits transfer-aborted and removes inbound state on peerLeft', async () => {
    const pm = makePeerManager();
    const fmSender = new FileManager(pm);
    const pmReceiver = makePeerManager();
    const fmReceiver = new FileManager(pmReceiver);

    const aborted = [];
    fmReceiver.addEventListener('transfer-aborted', (e) => aborted.push(e.detail));

    // Only send file-start, never send chunks/end → simulate mid-transfer disconnect
    await fmSender.sendFile('peer-b', makeFile('partial content'));
    const startFrame = pm.sent[0]; // only relay the start message
    pmReceiver.emit('message', { peerId: 'peer-a', label: 'file', data: startFrame.data });

    fmReceiver.peerLeft('peer-a');

    expect(aborted.length).toBe(1);
    expect(aborted[0].peerId).toBe('peer-a');
  });
});

// ── Concurrent transfers ─────────────────────────────────────────────────

describe('FileManager — concurrent transfers', () => {
  it('two simultaneous outbound transfers to same peer complete independently', async () => {
    const pm = makePeerManager();
    const fm = new FileManager(pm);

    const id1 = crypto.randomUUID();
    const id2 = crypto.randomUUID();

    const p1 = fm.sendFile('peer-b', makeFile('file one content'), id1);
    const p2 = fm.sendFile('peer-b', makeFile('file two content'), id2);
    await Promise.all([p1, p2]);

    const starts = pm.sent.filter(f => {
      if (typeof f.data !== 'string') return false;
      const m = JSON.parse(f.data);
      return m.type === 'file-start';
    });
    expect(starts).toHaveLength(2);
    const ids = starts.map(s => JSON.parse(s.data).id);
    expect(ids).toContain(id1);
    expect(ids).toContain(id2);
  });

  it('two inbound transfers with different IDs are reassembled independently', async () => {
    const pmSender1 = makePeerManager();
    const pmSender2 = makePeerManager();
    const fmSender1 = new FileManager(pmSender1);
    const fmSender2 = new FileManager(pmSender2);
    const pmReceiver = makePeerManager();
    const fmReceiver = new FileManager(pmReceiver);

    const received = [];
    fmReceiver.addEventListener('file-received', (e) => received.push(e.detail));

    await fmSender1.sendFile('receiver', makeFile('transfer A data'));
    await fmSender2.sendFile('receiver', makeFile('transfer B data'));

    // Replay both transfers into the receiver (interleaved)
    for (const frame of pmSender1.sent) {
      pmReceiver.emit('message', { peerId: 'sender-a', label: 'file', data: frame.data });
    }
    for (const frame of pmSender2.sent) {
      pmReceiver.emit('message', { peerId: 'sender-b', label: 'file', data: frame.data });
    }

    expect(received).toHaveLength(2);
    const names = received.map(r => r.name);
    expect(names).toContain('test.txt');
    expect(received.every(r => r.blob.size > 0)).toBe(true);
  });
});

// ── Multi-peer transfers ─────────────────────────────────────────────────

describe('FileManager — multi-peer', () => {
  it('sendFile to two peers sends frames for each independently', async () => {
    const pm = makePeerManager();
    const fm = new FileManager(pm);

    const id1 = crypto.randomUUID();
    const id2 = crypto.randomUUID();

    await fm.sendFile('peer-b', makeFile('hello peer-b'), id1);
    await fm.sendFile('peer-c', makeFile('hello peer-c'), id2);

    const toPeerB = pm.sent.filter(f => f.peerId === 'peer-b');
    const toPeerC = pm.sent.filter(f => f.peerId === 'peer-c');

    expect(toPeerB.length).toBeGreaterThan(0);
    expect(toPeerC.length).toBeGreaterThan(0);

    const startB = JSON.parse(toPeerB[0].data);
    const startC = JSON.parse(toPeerC[0].data);
    expect(startB.id).not.toBe(startC.id);
  });

  it('peerLeft only aborts transfers from the disconnected peer', async () => {
    const pmSenderA = makePeerManager();
    const pmSenderB = makePeerManager();
    const fmSenderA = new FileManager(pmSenderA);
    const fmSenderB = new FileManager(pmSenderB);
    const pmReceiver = makePeerManager();
    const fmReceiver = new FileManager(pmReceiver);

    const aborted = [];
    fmReceiver.addEventListener('transfer-aborted', (e) => aborted.push(e.detail));

    // Start a transfer from peer-a
    await fmSenderA.sendFile('receiver', makeFile('from a'));
    const startA = pmSenderA.sent[0]; // only relay file-start from A
    pmReceiver.emit('message', { peerId: 'peer-a', label: 'file', data: startA.data });

    // Start a transfer from peer-b (fully relay it)
    await fmSenderB.sendFile('receiver', makeFile('from b'));
    for (const frame of pmSenderB.sent) {
      pmReceiver.emit('message', { peerId: 'peer-b', label: 'file', data: frame.data });
    }

    // peer-a leaves — should only abort peer-a's transfer
    fmReceiver.peerLeft('peer-a');

    expect(aborted).toHaveLength(1);
    expect(aborted[0].peerId).toBe('peer-a');
    // peer-b's completed transfer is NOT affected
    expect(fmReceiver._inbound.has(aborted[0].id)).toBe(false); // cleaned up
  });
});
