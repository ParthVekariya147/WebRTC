// Phase 4.5 exit tests — File transfer rendering
//
// Exit criteria:
//   ✓ Receiver sees inline image preview when chat is open during transfer
//   ✓ Receiver sees inline image preview when opening chat AFTER transfer (re-render path)
//   ✓ Sidebar last-message preview shows emoji label, never "undefined" or empty
//   ✓ Room chat correctly blocks file sending and shows system message

import { test, expect, chromium } from '@playwright/test';

const APP = 'http://localhost:5173/app.html';

// Minimal 1×1 transparent PNG — fast to transfer, valid image
const TINY_PNG = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVQI12NgAAIABQAABjE+ibYAAAAASUVORK5CYII=',
    'base64'
);

let browser;
test.beforeAll(async () => {
    browser = await chromium.launch({
        args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'],
    });
});
test.afterAll(() => browser.close());

async function joinPeer(room, name) {
    const ctx  = await browser.newContext();
    const page = await ctx.newPage();
    await page.goto(`${APP}?room=${room}`);
    await page.waitForFunction(() => typeof window.joinRoom === 'function', { timeout: 15000 });
    await page.fill('#my-name', name);
    await page.click('#join-btn');
    await expect(page.locator('#display-room-id')).toHaveText(room, { timeout: 10000 });
    return { ctx, page };
}

async function waitForOnline(page, peerName) {
    await page.locator('.peer-item:not(.room-item)', { hasText: peerName }).click();
    await expect(page.locator('#active-peer-status')).toHaveText('Online — Direct P2P', { timeout: 15000 });
}

async function stageFile(page, filename, mimeType, buffer) {
    await page.setInputFiles('#file-input', { name: filename, mimeType, buffer });
}

// ── Test 1: live transfer (chat open throughout) ───────────────────────────
test('Phase 4.5 — receiver sees inline image preview (chat open during transfer)', async () => {
    const room  = `p45-live-${Date.now()}`;
    const alice = await joinPeer(room, 'alice');
    const bob   = await joinPeer(room, 'bob');

    try {
        await waitForOnline(alice.page, 'bob');

        // Bob opens chat with Alice before any files are sent
        await bob.page.locator('.peer-item:not(.room-item)', { hasText: 'alice' }).click();
        await expect(bob.page.locator('#active-peer-name')).toHaveText('alice', { timeout: 5000 });

        // Alice stages 3 images and sends them
        for (let i = 0; i < 3; i++) {
            await stageFile(alice.page, `photo-${i}.png`, 'image/png', TINY_PNG);
        }
        await expect(alice.page.locator('#file-stage-panel')).toHaveClass(/visible/);
        await alice.page.keyboard.press('Enter');

        // Bob should see 3 image previews in the open chat
        await expect(bob.page.locator('.received-img')).toHaveCount(3, { timeout: 30000 });
    } finally {
        await Promise.all([alice.ctx.close(), bob.ctx.close()]);
    }
});

// ── Test 2: re-render path (chat opened AFTER files arrived) ──────────────
test('Phase 4.5 — receiver sees image previews after opening chat (re-render path)', async () => {
    const room  = `p45-reopen-${Date.now()}`;
    const alice = await joinPeer(room, 'alice');
    const bob   = await joinPeer(room, 'bob');

    try {
        await waitForOnline(alice.page, 'bob');

        // Bob stays on Room chat — NOT looking at Alice's 1-on-1 chat
        await bob.page.locator('.peer-item.room-item').click();
        await expect(bob.page.locator('#active-peer-name')).toHaveText('Room — everyone', { timeout: 5000 });

        // Alice sends 3 images to Bob
        for (let i = 0; i < 3; i++) {
            await stageFile(alice.page, `img-${i}.png`, 'image/png', TINY_PNG);
        }
        await alice.page.keyboard.press('Enter');

        // Wait until Bob has an unread badge on Alice's entry in the sidebar
        await expect(
            bob.page.locator('.peer-item:not(.room-item) .unread-dot')
        ).toBeVisible({ timeout: 30000 });

        // Bob opens the chat with Alice — re-render path must show 3 previews
        await bob.page.locator('.peer-item:not(.room-item)', { hasText: 'alice' }).click();
        await expect(bob.page.locator('.received-img')).toHaveCount(3, { timeout: 10000 });
    } finally {
        await Promise.all([alice.ctx.close(), bob.ctx.close()]);
    }
});

// ── Test 3: sidebar preview label ─────────────────────────────────────────
test('Phase 4.5 — sidebar shows emoji file label, never shows "undefined"', async () => {
    const room  = `p45-sidebar-${Date.now()}`;
    const alice = await joinPeer(room, 'alice');
    const bob   = await joinPeer(room, 'bob');

    try {
        await waitForOnline(alice.page, 'bob');

        // Bob stays on Room — not looking at Alice's chat
        await bob.page.locator('.peer-item.room-item').click();

        // Alice sends one image
        await stageFile(alice.page, 'photo.png', 'image/png', TINY_PNG);
        await alice.page.keyboard.press('Enter');

        // Wait for sidebar unread badge, then check preview text
        await expect(
            bob.page.locator('.peer-item:not(.room-item) .unread-dot')
        ).toBeVisible({ timeout: 30000 });

        const preview = bob.page.locator('.peer-item:not(.room-item) .peer-preview');
        await expect(preview).not.toContainText('undefined');
        await expect(preview).not.toHaveText('');
        await expect(preview).toContainText('📷');

        // Alice's sidebar should also not show "undefined" for sent file
        const alicePreview = alice.page.locator('.peer-item:not(.room-item) .peer-preview');
        await expect(alicePreview).not.toContainText('undefined');
        await expect(alicePreview).toContainText('📷');
    } finally {
        await Promise.all([alice.ctx.close(), bob.ctx.close()]);
    }
});

// ── Test 4: Room chat blocks file sending ──────────────────────────────────
test('Phase 4.5 — Room chat blocks file sending and shows system message', async () => {
    const room  = `p45-room-block-${Date.now()}`;
    const alice = await joinPeer(room, 'alice');
    const bob   = await joinPeer(room, 'bob');

    try {
        // Alice opens Room chat (not a 1-on-1)
        await alice.page.locator('.peer-item.room-item').click();
        await expect(alice.page.locator('#active-peer-name')).toHaveText('Room — everyone', { timeout: 5000 });

        // Stage a file and try to send from Room chat
        await stageFile(alice.page, 'photo.png', 'image/png', TINY_PNG);
        await alice.page.keyboard.press('Enter');

        // Should show the block system message
        await expect(alice.page.locator('#messages-area'))
            .toContainText('To send files, select a specific peer', { timeout: 5000 });

        // File stage panel should be cleared
        await expect(alice.page.locator('#file-stage-panel')).not.toHaveClass(/visible/);
    } finally {
        await Promise.all([alice.ctx.close(), bob.ctx.close()]);
    }
});
