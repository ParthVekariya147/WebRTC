// Phase 3 exit test — chunked file transfer over the 'file' DataChannel
//
// Exit criteria:
//   ✓ Small file (< 1 chunk): attach-bar clears, sender "Sent ✓", receiver gets blob link
//   ✓ Multi-chunk file (33 KB → 3 chunks): all chunks reassembled, filename preserved
//   ✓ Text + file in same session: both delivered independently
//   ✓ Peer disconnect mid-transfer: graceful cleanup, sender sees "bob left"
//
// One shared Chromium process; each test gets isolated browser contexts.
// try/finally on contexts guarantees cleanup even on failure.

import { test, expect, chromium } from '@playwright/test';

const BASE = 'http://localhost:5173';
const APP  = `${BASE}/app.html`;

// ── Shared browser (warm across all phase-3 tests) ─────────────────────────
let browser;
test.beforeAll(async () => {
    browser = await chromium.launch({
        args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'],
    });
});
test.afterAll(async () => {
    await browser.close();
});

// ── Helper: spin up two fresh contexts, join them, wait for P2P ────────────
async function connectPeers(room) {
    const [ctxA, ctxB] = await Promise.all([
        browser.newContext(),
        browser.newContext(),
    ]);
    const [pgA, pgB] = await Promise.all([ctxA.newPage(), ctxB.newPage()]);

    // Capture browser-side errors for diagnostics
    const errorsA = [], errorsB = [];
    pgA.on('console', m => { if (m.type() === 'error') errorsA.push(m.text()); });
    pgB.on('console', m => { if (m.type() === 'error') errorsB.push(m.text()); });

    await Promise.all([
        pgA.goto(`${APP}?room=${room}`),
        pgB.goto(`${APP}?room=${room}`),
    ]);

    // Wait until the module script has finished initialising (joinRoom assigned to window)
    await Promise.all([
        pgA.waitForFunction(() => typeof window.joinRoom === 'function', { timeout: 15000 }),
        pgB.waitForFunction(() => typeof window.joinRoom === 'function', { timeout: 15000 }),
    ]);

    // Sequential join: Alice first so Bob receives room-peers:[alice] and makes the offer.
    // This avoids simultaneous-offer glare (perfect negotiation handles it anyway, but
    // this eliminates the need for a rollback race in ICE-based tests).
    await pgA.fill('#my-name', 'alice');
    await pgA.click('#join-btn');
    // Wait for Alice to be registered in the room (signaling round-trip complete)
    await expect(pgA.locator('#display-room-id')).toHaveText(room, { timeout: 10000 });

    await pgB.fill('#my-name', 'bob');
    await pgB.click('#join-btn');
    // Wait for Bob to be in the room too
    await expect(pgB.locator('#display-room-id')).toHaveText(room, { timeout: 10000 });

    // Both must see each other in the peer list (requires DataChannel open).
    // Use :not(.room-item) to exclude the Phase 4 Room group item (always first in DOM).
    await expect(pgA.locator('.peer-item:not(.room-item)')).toBeVisible({ timeout: 20000 });
    await expect(pgB.locator('.peer-item:not(.room-item)')).toBeVisible({ timeout: 20000 });

    // Open chat on both sides
    await pgA.locator('.peer-item:not(.room-item)').first().click();
    await pgB.locator('.peer-item:not(.room-item)').first().click();

    // Confirm direct P2P is established
    await expect(pgA.locator('#active-peer-status')).toHaveText('Online — Direct P2P', { timeout: 12000 });
    await expect(pgB.locator('#active-peer-status')).toHaveText('Online — Direct P2P', { timeout: 12000 });

    return { pgA, pgB, ctxA, ctxB, errorsA, errorsB };
}

// ── Test 1: small file (< 1 chunk, 50 bytes) ──────────────────────────────
test('Phase 3 — small file: attach-bar clears, Sent ✓, receiver gets download link', async () => {
    const room = `p3-small-${Date.now()}`;
    const { pgA, pgB, ctxA, ctxB, errorsA } = await connectPeers(room);
    try {
        // Alice selects a small text file via the hidden file input
        await pgA.locator('#file-input').setInputFiles({
            name: 'hello.txt',
            mimeType: 'text/plain',
            buffer: Buffer.from('Hello from Alice via WebRTC Phase 3 file transfer!'),
        });

        // Attach bar must show the filename before sending
        await expect(pgA.locator('#attach-bar')).toBeVisible({ timeout: 3000 });
        await expect(pgA.locator('#attach-name')).toHaveText('hello.txt', { timeout: 2000 });

        // Send — attach bar must clear immediately (same as input clearing after text send)
        await pgA.locator('.send-btn').click();
        await expect(pgA.locator('#attach-bar')).not.toBeVisible({ timeout: 3000 });

        // Alice's chat shows a file-xfer progress bubble
        await expect(pgA.locator('.file-xfer')).toBeVisible({ timeout: 5000 });

        // Alice's status reaches "Sent ✓" after all chunks are sent
        await expect(pgA.locator('.file-xfer-status').first()).toHaveText('Sent ✓', { timeout: 15000 });

        // Bob sees a download link with the original filename
        await expect(pgB.locator('.file-xfer-link')).toBeVisible({ timeout: 20000 });
        expect(await pgB.locator('.file-xfer-link').getAttribute('download')).toBe('hello.txt');

        // href must be a blob: URL (created locally by URL.createObjectURL)
        const href = await pgB.locator('.file-xfer-link').getAttribute('href');
        expect(href).toMatch(/^blob:/);

        // Bob's bubble shows "Download ready"
        await expect(pgB.locator('.file-xfer-status').first()).toHaveText('Download ready', { timeout: 5000 });

        // No fatal browser errors
        const fatal = errorsA.filter(e =>
            !e.includes('_handleOffer') && !e.includes('_handleAnswer') && !e.includes('addIceCandidate')
        );
        expect(fatal, `Fatal JS errors on alice: ${fatal.join('; ')}`).toHaveLength(0);
    } finally {
        await Promise.all([ctxA.close(), ctxB.close()]);
    }
});

// ── Test 2: multi-chunk file (33 KB → 3 chunks at 16 KB each) ─────────────
test('Phase 3 — multi-chunk file: all chunks reassembled, filename preserved', async () => {
    const room = `p3-multi-${Date.now()}`;
    const { pgA, pgB, ctxA, ctxB } = await connectPeers(room);
    try {
        await pgA.locator('#file-input').setInputFiles({
            name: 'bigfile.bin',
            mimeType: 'application/octet-stream',
            buffer: Buffer.alloc(33 * 1024, 0x42), // 33 KB of 'B'
        });

        await pgA.locator('.send-btn').click();

        // Bob receives all 3 chunks and the download link appears
        await expect(pgB.locator('.file-xfer-link')).toBeVisible({ timeout: 30000 });
        expect(await pgB.locator('.file-xfer-link').getAttribute('download')).toBe('bigfile.bin');

        // Alice's sender bubble shows "Sent ✓" after the final progress event
        await expect(pgA.locator('.file-xfer-status').first()).toHaveText('Sent ✓', { timeout: 15000 });

        // Bob's bubble shows "Download ready"
        await expect(pgB.locator('.file-xfer-status').first()).toHaveText('Download ready', { timeout: 5000 });
    } finally {
        await Promise.all([ctxA.close(), ctxB.close()]);
    }
});

// ── Test 3: text message + file in same session ────────────────────────────
test('Phase 3 — text + file in same session: both delivered independently', async () => {
    const room = `p3-mixed-${Date.now()}`;
    const { pgA, pgB, ctxA, ctxB } = await connectPeers(room);
    try {
        // Chat message on the 'chat' DataChannel
        await pgA.fill('#msg-input', 'check the attachment');
        await pgA.keyboard.press('Enter');
        await expect(pgB.locator('#messages-area')).toContainText('check the attachment', { timeout: 8000 });

        // File on the 'file' DataChannel
        await pgA.locator('#file-input').setInputFiles({
            name: 'notes.txt',
            mimeType: 'text/plain',
            buffer: Buffer.from('Phase 3 file transfer alongside chat!'),
        });
        await pgA.locator('.send-btn').click();

        // Bob sees both the text message and the download link
        await expect(pgB.locator('#messages-area')).toContainText('check the attachment');
        await expect(pgB.locator('.file-xfer-link')).toBeVisible({ timeout: 20000 });
        expect(await pgB.locator('.file-xfer-link').getAttribute('download')).toBe('notes.txt');
    } finally {
        await Promise.all([ctxA.close(), ctxB.close()]);
    }
});

// ── Test 4: peer disconnect mid-transfer — graceful cleanup ────────────────
test('Phase 3 — peer disconnect mid-transfer: graceful cleanup, no crash', async () => {
    const room = `p3-abort-${Date.now()}`;
    const { pgA, pgB, ctxA, ctxB } = await connectPeers(room);
    try {
        // Start sending a 500 KB file — enough chunks to allow mid-transfer close
        await pgA.locator('#file-input').setInputFiles({
            name: 'large.bin',
            mimeType: 'application/octet-stream',
            buffer: Buffer.alloc(500 * 1024, 0xab),
        });
        await pgA.locator('.send-btn').click();

        // Wait for Alice's file-xfer bubble (transfer has started)
        await expect(pgA.locator('.file-xfer')).toBeVisible({ timeout: 5000 });

        // Close Bob's context mid-transfer
        await ctxB.close();

        // Alice must see "bob left" — confirms peerLeft cleanup ran without a JS crash
        await expect(pgA.locator('#messages-area')).toContainText('bob left', { timeout: 12000 });

        // Alice's peer list must show bob as offline
        await expect(pgA.locator('.status-dot')).toHaveClass(/offline/, { timeout: 5000 });
    } finally {
        await ctxA.close();
        // ctxB already closed above — close() is idempotent in Playwright
    }
});
