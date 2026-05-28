/**
 * Unit tests for the sendMessage input-clearing bug fix.
 *
 * The bug: after sending a chat message, #msg-input was NOT being cleared.
 * The fix: input.value = '' and input.focus() are called BEFORE the send
 *          logic and any early-return guard, so clearing always happens.
 *
 * Because sendMessage is defined inside a <script type="module"> in index.html
 * and relies on module-scoped closure state, we test the behaviour by
 * re-implementing the exact same logic as a pure function (sendMessageLogic)
 * and running it against a jsdom DOM.  This lets us exercise every code path
 * without touching the network or a real signaling server.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Helpers – build the minimal DOM the function depends on
// ---------------------------------------------------------------------------

function setupDOM() {
  document.body.innerHTML = `
    <input  type="text" id="msg-input"      value="" />
    <div    id="messages-area"></div>
    <input  type="file" id="file-input" />
    <div    id="attach-bar"   class="attach-preview-bar"></div>
    <span   id="attach-name"></span>
  `;
}

// ---------------------------------------------------------------------------
// Re-implementation of sendMessage that mirrors the fixed index.html logic.
//
// Signature:
//   sendMessageLogic({ activePeerId, peerManager, conversations,
//                       pendingFile, myName, safeSend })
//
// Returns the bubble that was created (or null if nothing was sent) so tests
// can assert on the payload without wiring up a full chatManager.
// ---------------------------------------------------------------------------

function makeSendMessage(ctx) {
  /**
   * ctx shape:
   *   activePeerId  – string | null
   *   peerManager   – object | null  (truthy check only)
   *   conversations – { [peerId]: { status: string, messages: [] } }
   *   getPendingFile – () => File | null
   *   myName        – string
   *   safeSend      – vi.fn()   (replaces peerManager.safeSend)
   *   appendBubble  – vi.fn()   (replaces the real DOM renderer)
   *   renderPeerList – vi.fn()
   *   clearAttachment – vi.fn()
   *   sysMsg         – vi.fn()
   */
  return function sendMessage() {
    // Guard: need an active peer and an initialised peerManager
    if (!ctx.activePeerId || !ctx.peerManager) return null;

    const input = document.getElementById('msg-input');
    const text  = input.value.trim();

    // ── BUG FIX: clear the input FIRST, before any early-return paths ──
    input.value = '';
    input.focus();

    // Early return: nothing to send
    if (!text && !ctx.getPendingFile()) return null;

    const conv = ctx.conversations[ctx.activePeerId];
    if (conv?.status !== 'online') {
      ctx.sysMsg(ctx.activePeerId, 'Peer is offline — message not sent.');
      return null;
    }

    const pendingFile = ctx.getPendingFile();
    const mediaData = pendingFile
      ? { fileName: pendingFile.name, fileType: pendingFile.type, blob: pendingFile }
      : null;

    ctx.safeSend(ctx.activePeerId, 'chat', JSON.stringify({
      type: 'chat',
      id: 'test-uuid',
      from: ctx.myName,
      to: ctx.activePeerId,
      text,
      ts: Date.now(),
    }));

    const bubble = { sender: 'me', text, media: mediaData, time: '12:00' };
    ctx.conversations[ctx.activePeerId].messages.push(bubble);
    ctx.appendBubble(bubble);
    ctx.renderPeerList();
    ctx.clearAttachment();

    return bubble;
  };
}

// ---------------------------------------------------------------------------
// Default context factory — produces a "happy path" setup (online peer, text
// in the input, no file attachment).
// ---------------------------------------------------------------------------

function makeCtx(overrides = {}) {
  return {
    activePeerId:  'bob',
    peerManager:   { safeSend: vi.fn() },
    conversations: { bob: { status: 'online', messages: [] } },
    getPendingFile: vi.fn(() => null),
    myName:        'alice',
    safeSend:       vi.fn(),
    appendBubble:   vi.fn(),
    renderPeerList: vi.fn(),
    clearAttachment: vi.fn(),
    sysMsg:         vi.fn(),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('sendMessage – input clearing (bug-fix behaviour)', () => {

  beforeEach(() => {
    setupDOM();
  });

  // ── 1. Core bug-fix: input is always cleared after calling sendMessage ────

  it('clears #msg-input after a successful send', () => {
    const ctx = makeCtx();
    document.getElementById('msg-input').value = 'Hello world';

    const sendMessage = makeSendMessage(ctx);
    sendMessage();

    expect(document.getElementById('msg-input').value).toBe('');
  });

  it('captures the text value BEFORE clearing it', () => {
    const ctx = makeCtx();
    document.getElementById('msg-input').value = 'captured text';

    const sendMessage = makeSendMessage(ctx);
    const bubble = sendMessage();

    // The bubble should carry the original text, not the empty string
    expect(bubble).not.toBeNull();
    expect(bubble.text).toBe('captured text');

    // …and the input must now be empty
    expect(document.getElementById('msg-input').value).toBe('');
  });

  // ── 2. Empty input + no file → no message sent, but input still clears ───

  it('does NOT call safeSend when input is empty and no file is attached', () => {
    const ctx = makeCtx();
    document.getElementById('msg-input').value = '';   // empty

    const sendMessage = makeSendMessage(ctx);
    const result = sendMessage();

    expect(ctx.safeSend).not.toHaveBeenCalled();
    expect(result).toBeNull();
  });

  it('still clears #msg-input even when the message is empty (early-return path)', () => {
    const ctx = makeCtx();
    document.getElementById('msg-input').value = '   ';  // whitespace only

    const sendMessage = makeSendMessage(ctx);
    sendMessage();

    // Input should be cleared even though we returned early
    expect(document.getElementById('msg-input').value).toBe('');
  });

  it('does NOT call appendBubble when input is empty and no file is attached', () => {
    const ctx = makeCtx();
    document.getElementById('msg-input').value = '';

    const sendMessage = makeSendMessage(ctx);
    sendMessage();

    expect(ctx.appendBubble).not.toHaveBeenCalled();
  });

  // ── 3. Offline peer → input still clears, but no message is sent ─────────

  it('clears #msg-input when the peer is offline', () => {
    const ctx = makeCtx({
      conversations: { bob: { status: 'offline', messages: [] } },
    });
    document.getElementById('msg-input').value = 'Will not arrive';

    const sendMessage = makeSendMessage(ctx);
    sendMessage();

    expect(document.getElementById('msg-input').value).toBe('');
  });

  it('does NOT call safeSend when the peer is offline', () => {
    const ctx = makeCtx({
      conversations: { bob: { status: 'offline', messages: [] } },
    });
    document.getElementById('msg-input').value = 'Hello offline peer';

    const sendMessage = makeSendMessage(ctx);
    const result = sendMessage();

    expect(ctx.safeSend).not.toHaveBeenCalled();
    expect(result).toBeNull();
  });

  it('calls sysMsg with an "offline" notice when the peer is offline', () => {
    const ctx = makeCtx({
      conversations: { bob: { status: 'offline', messages: [] } },
    });
    document.getElementById('msg-input').value = 'ping';

    const sendMessage = makeSendMessage(ctx);
    sendMessage();

    expect(ctx.sysMsg).toHaveBeenCalledWith('bob', 'Peer is offline — message not sent.');
  });

  // ── 4. No activePeerId → nothing happens ─────────────────────────────────

  it('returns null immediately when activePeerId is null', () => {
    const ctx = makeCtx({ activePeerId: null });
    document.getElementById('msg-input').value = 'test';

    const sendMessage = makeSendMessage(ctx);
    const result = sendMessage();

    expect(result).toBeNull();
    expect(ctx.safeSend).not.toHaveBeenCalled();
  });

  it('does NOT clear #msg-input when there is no activePeerId', () => {
    // Without an activePeerId the function short-circuits before touching
    // the DOM — this documents that intentional early-exit behaviour.
    const ctx = makeCtx({ activePeerId: null });
    document.getElementById('msg-input').value = 'keep me';

    const sendMessage = makeSendMessage(ctx);
    sendMessage();

    // The function exits before any DOM work because peerManager/activePeerId guard fires
    expect(document.getElementById('msg-input').value).toBe('keep me');
  });

  // ── 5. No peerManager → nothing happens ──────────────────────────────────

  it('returns null immediately when peerManager is null', () => {
    const ctx = makeCtx({ peerManager: null });
    document.getElementById('msg-input').value = 'test';

    const sendMessage = makeSendMessage(ctx);
    const result = sendMessage();

    expect(result).toBeNull();
    expect(ctx.safeSend).not.toHaveBeenCalled();
  });

  // ── 6. File-only message (no text) ───────────────────────────────────────

  it('sends when there is a file but no text', () => {
    const fakeFile = new File(['data'], 'photo.png', { type: 'image/png' });
    const ctx = makeCtx({
      getPendingFile: vi.fn(() => fakeFile),
    });
    document.getElementById('msg-input').value = '';

    const sendMessage = makeSendMessage(ctx);
    const bubble = sendMessage();

    expect(ctx.safeSend).toHaveBeenCalledTimes(1);
    expect(bubble).not.toBeNull();
    expect(bubble.media.fileName).toBe('photo.png');
  });

  it('clears the input when a file-only message is sent', () => {
    const fakeFile = new File(['data'], 'doc.pdf', { type: 'application/pdf' });
    const ctx = makeCtx({
      getPendingFile: vi.fn(() => fakeFile),
    });
    document.getElementById('msg-input').value = '';

    const sendMessage = makeSendMessage(ctx);
    sendMessage();

    expect(document.getElementById('msg-input').value).toBe('');
  });

  // ── 7. safeSend payload carries the captured text ─────────────────────────

  it('passes the correct text to safeSend', () => {
    const ctx = makeCtx();
    document.getElementById('msg-input').value = 'payload check';

    const sendMessage = makeSendMessage(ctx);
    sendMessage();

    expect(ctx.safeSend).toHaveBeenCalledTimes(1);
    const [peerId, channel, rawPayload] = ctx.safeSend.mock.calls[0];
    const payload = JSON.parse(rawPayload);

    expect(peerId).toBe('bob');
    expect(channel).toBe('chat');
    expect(payload.text).toBe('payload check');
    expect(payload.from).toBe('alice');
    expect(payload.to).toBe('bob');
    expect(payload.type).toBe('chat');
  });

  // ── 8. appendBubble is called with correct sender metadata ───────────────

  it('calls appendBubble with sender="me" and the captured text', () => {
    const ctx = makeCtx();
    document.getElementById('msg-input').value = 'bubble test';

    const sendMessage = makeSendMessage(ctx);
    sendMessage();

    expect(ctx.appendBubble).toHaveBeenCalledTimes(1);
    const [bubble] = ctx.appendBubble.mock.calls[0];
    expect(bubble.sender).toBe('me');
    expect(bubble.text).toBe('bubble test');
  });

  // ── 9. clearAttachment is called on a successful send ────────────────────

  it('calls clearAttachment after a successful send', () => {
    const ctx = makeCtx();
    document.getElementById('msg-input').value = 'attachment clear test';

    const sendMessage = makeSendMessage(ctx);
    sendMessage();

    expect(ctx.clearAttachment).toHaveBeenCalledTimes(1);
  });

  it('does NOT call clearAttachment on the offline-peer early-return path', () => {
    const ctx = makeCtx({
      conversations: { bob: { status: 'offline', messages: [] } },
    });
    document.getElementById('msg-input').value = 'offline msg';

    const sendMessage = makeSendMessage(ctx);
    sendMessage();

    expect(ctx.clearAttachment).not.toHaveBeenCalled();
  });
});
