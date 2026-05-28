// Phase 4 exit test — Multi-peer mesh + Room broadcast
//
// Exit criteria:
//   ✓ 3 peers join the same room; each sees the other two in the sidebar
//   ✓ Full mesh: Alice-Bob, Alice-Carol, Bob-Carol DataChannels all reach "Online"
//   ✓ Room broadcast: Alice sends to Room, both Bob AND Carol receive it
//   ✓ 1-on-1 stays private: Alice sends directly to Bob, Carol does NOT receive it
//
// Infrastructure: shared Chromium process (warm across tests), isolated contexts per test.

import { test, expect, chromium } from '@playwright/test';

const BASE = 'http://localhost:5173';
const APP  = `${BASE}/app.html`;

let browser;
test.beforeAll(async () => {
    browser = await chromium.launch({
        args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'],
    });
});
test.afterAll(async () => { await browser.close(); });

// ── Helpers ────────────────────────────────────────────────────────────────

async function joinPeer(browser, room, name) {
    const ctx  = await browser.newContext();
    const page = await ctx.newPage();
    await page.goto(`${APP}?room=${room}`);
    await page.waitForFunction(() => typeof window.joinRoom === 'function', { timeout: 15000 });
    await page.fill('#my-name', name);
    await page.click('#join-btn');
    await expect(page.locator('#display-room-id')).toHaveText(room, { timeout: 10000 });
    return { ctx, page };
}

async function waitForPeerCount(page, count) {
    // Wait until the peer list shows `count` individual peer-items (not the Room item)
    await expect(page.locator('.peer-item:not(.room-item)')).toHaveCount(count, { timeout: 25000 });
}

async function waitForOnline(page, peerName) {
    await page.locator('.peer-item:not(.room-item)', { hasText: peerName }).click();
    await expect(page.locator('#active-peer-status')).toHaveText('Online — Direct P2P', { timeout: 15000 });
}

// ── Test 1: full 3-peer mesh ───────────────────────────────────────────────
test('Phase 4 — 3-peer mesh: all pairs connected, each peer sees the others', async () => {
    const room = `p4-mesh-${Date.now()}`;

    const alice = await joinPeer(browser, room, 'alice');
    const bob   = await joinPeer(browser, room, 'bob');
    const carol = await joinPeer(browser, room, 'carol');

    try {
        // Each peer must see exactly 2 others in the sidebar
        await waitForPeerCount(alice.page, 2);
        await waitForPeerCount(bob.page,   2);
        await waitForPeerCount(carol.page, 2);

        // Verify peer names are correct on Alice's page
        const names = await alice.page.locator('.peer-item:not(.room-item) .peer-name').allTextContents();
        expect(names.map(n => n.trim()).sort()).toEqual(['bob', 'carol']);

        // Full mesh: all 3 pairs reach "Online — Direct P2P"
        await waitForOnline(alice.page, 'bob');
        await waitForOnline(alice.page, 'carol');
        await waitForOnline(bob.page,   'alice');
        await waitForOnline(bob.page,   'carol');
    } finally {
        await Promise.all([alice.ctx.close(), bob.ctx.close(), carol.ctx.close()]);
    }
});

// ── Test 2: Room broadcast ─────────────────────────────────────────────────
test('Phase 4 — Room broadcast: message reaches all peers', async () => {
    const room = `p4-broadcast-${Date.now()}`;

    const alice = await joinPeer(browser, room, 'alice');
    const bob   = await joinPeer(browser, room, 'bob');
    const carol = await joinPeer(browser, room, 'carol');

    try {
        // Wait for full mesh
        await waitForPeerCount(alice.page, 2);
        await waitForPeerCount(bob.page,   2);
        await waitForPeerCount(carol.page, 2);

        // Verify Room item appears on all pages
        await expect(alice.page.locator('.peer-item.room-item')).toBeVisible({ timeout: 5000 });
        await expect(bob.page.locator('.peer-item.room-item')).toBeVisible({ timeout: 5000 });

        // Alice opens Room and waits for peers to be connected
        await alice.page.locator('.peer-item.room-item').click();
        await expect(alice.page.locator('#active-peer-name')).toHaveText('Room — everyone', { timeout: 3000 });

        // Wait for at least one peer to be online before sending
        await expect(alice.page.locator('#active-peer-status')).toContainText('peer', { timeout: 20000 });

        // Alice sends a broadcast message
        await alice.page.fill('#msg-input', 'hello everyone from alice');
        await alice.page.keyboard.press('Enter');
        await expect(alice.page.locator('#msg-input')).toHaveValue('', { timeout: 2000 });

        // Bob opens Room and sees Alice's message
        await bob.page.locator('.peer-item.room-item').click();
        await expect(bob.page.locator('#messages-area')).toContainText('hello everyone from alice', { timeout: 15000 });

        // Carol opens Room and also sees Alice's message
        await carol.page.locator('.peer-item.room-item').click();
        await expect(carol.page.locator('#messages-area')).toContainText('hello everyone from alice', { timeout: 15000 });
    } finally {
        await Promise.all([alice.ctx.close(), bob.ctx.close(), carol.ctx.close()]);
    }
});

// ── Test 3: 1-on-1 stays private ─────────────────────────────────────────
test('Phase 4 — 1-on-1 is private: Carol does not receive Alice→Bob direct message', async () => {
    const room = `p4-private-${Date.now()}`;

    const alice = await joinPeer(browser, room, 'alice');
    const bob   = await joinPeer(browser, room, 'bob');
    const carol = await joinPeer(browser, room, 'carol');

    try {
        await waitForPeerCount(alice.page, 2);
        await waitForPeerCount(bob.page,   2);
        await waitForPeerCount(carol.page, 2);

        // Wait for Alice-Bob to be online
        await waitForOnline(alice.page, 'bob');

        // Alice sends a direct message to Bob
        await alice.page.fill('#msg-input', 'private: only bob can read this');
        await alice.page.keyboard.press('Enter');

        // Bob receives the direct message
        await expect(bob.page.locator('.peer-item:not(.room-item)', { hasText: 'alice' }))
            .toBeVisible({ timeout: 5000 });
        await bob.page.locator('.peer-item:not(.room-item)', { hasText: 'alice' }).click();
        await expect(bob.page.locator('#messages-area'))
            .toContainText('private: only bob can read this', { timeout: 10000 });

        // Carol's Room does NOT contain the direct message
        await carol.page.locator('.peer-item.room-item').click();
        // Wait briefly and confirm it's still absent (Room should not have it)
        await carol.page.waitForTimeout(2000);
        await expect(carol.page.locator('#messages-area'))
            .not.toContainText('private: only bob can read this');

        // Carol's 1-on-1 with Alice also should not have it
        // (since Alice sent to Bob, not Alice→Carol)
        await carol.page.locator('.peer-item:not(.room-item)', { hasText: 'alice' }).click();
        await carol.page.waitForTimeout(500);
        await expect(carol.page.locator('#messages-area'))
            .not.toContainText('private: only bob can read this');
    } finally {
        await Promise.all([alice.ctx.close(), bob.ctx.close(), carol.ctx.close()]);
    }
});

// ── Test 4: peer leaves mesh, others remain connected ─────────────────────
test('Phase 4 — peer leaves: remaining pair stays online', async () => {
    const room = `p4-leave-${Date.now()}`;

    const alice = await joinPeer(browser, room, 'alice');
    const bob   = await joinPeer(browser, room, 'bob');
    const carol = await joinPeer(browser, room, 'carol');

    try {
        await waitForPeerCount(alice.page, 2);
        await waitForPeerCount(bob.page,   2);

        // Carol leaves
        await carol.ctx.close();

        // Alice's sidebar must show carol as offline (status-dot class changes)
        await expect(
            alice.page.locator('.peer-item:not(.room-item)', { hasText: 'carol' }).locator('.status-dot')
        ).toHaveClass(/offline/, { timeout: 10000 });

        // Alice and Bob can still communicate (their 1-on-1 is unaffected)
        await waitForOnline(alice.page, 'bob');
        await alice.page.fill('#msg-input', 'still connected after carol left');
        await alice.page.keyboard.press('Enter');

        await bob.page.locator('.peer-item:not(.room-item)', { hasText: 'alice' }).click();
        await expect(bob.page.locator('#messages-area'))
            .toContainText('still connected after carol left', { timeout: 10000 });
    } finally {
        // carol.ctx already closed above
        await Promise.all([alice.ctx.close(), bob.ctx.close()]);
    }
});
