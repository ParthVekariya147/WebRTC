// ChatManager unit tests — no browser APIs required
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ChatManager } from './chatManager.js';

// Minimal PeerManager stub
function makePeerManager(localPeerId = 'local-peer') {
  const listeners = {};
  return {
    localPeerId,
    getPeerIds: vi.fn(() => ['peer-b', 'peer-c']),
    safeSend: vi.fn(() => true),
    addEventListener: (type, fn) => { listeners[type] = fn; },
    emit: (type, detail) => listeners[type]?.({ detail }),
  };
}

describe('ChatManager', () => {
  let pm, chat;

  beforeEach(() => {
    pm = makePeerManager();
    chat = new ChatManager(pm);
  });

  it('broadcasts a message to all peers via safeSend', () => {
    chat.send('hello world');
    expect(pm.safeSend).toHaveBeenCalledTimes(2); // peer-b + peer-c
    const payload = JSON.parse(pm.safeSend.mock.calls[0][2]);
    expect(payload.text).toBe('hello world');
    expect(payload.type).toBe('chat');
    expect(payload.from).toBe('local-peer');
    expect(payload.id).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('emits message locally for the sender', () => {
    const received = [];
    chat.addEventListener('message', (e) => received.push(e.detail));
    chat.send('hi');
    expect(received).toHaveLength(1);
    expect(received[0].text).toBe('hi');
  });

  it('deduplicates messages by id', () => {
    const received = [];
    chat.addEventListener('message', (e) => received.push(e.detail));

    const msg = { type: 'chat', id: 'dup-id', from: 'peer-b', text: 'dupe', ts: Date.now() };
    pm.emit('message', { label: 'chat', data: JSON.stringify(msg) });
    pm.emit('message', { label: 'chat', data: JSON.stringify(msg) });

    expect(received).toHaveLength(1);
  });

  it('ignores messages on non-chat channels', () => {
    const received = [];
    chat.addEventListener('message', (e) => received.push(e.detail));

    pm.emit('message', { label: 'file', data: JSON.stringify({ type: 'chat', id: 'x', text: 'nope' }) });
    expect(received).toHaveLength(0);
  });

  it('ignores malformed JSON', () => {
    expect(() => {
      pm.emit('message', { label: 'chat', data: 'not json' });
    }).not.toThrow();
  });
});
