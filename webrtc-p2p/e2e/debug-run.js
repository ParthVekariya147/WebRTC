const { chromium } = require('@playwright/test');

(async () => {
    const BASE = 'http://localhost:5173';
    const room = `debug-${Date.now()}`;
    const browser = await chromium.launch({
        args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'],
        headless: true,
    });
    
    const [ctxA, ctxB] = await Promise.all([browser.newContext(), browser.newContext()]);
    const [pgA, pgB] = await Promise.all([ctxA.newPage(), ctxB.newPage()]);
    
    pgA.on('console', m => { if (m.type() !== 'warning') console.log(`[A:${m.type()}] ${m.text().slice(0,120)}`); });
    pgB.on('console', m => { if (m.type() !== 'warning') console.log(`[B:${m.type()}] ${m.text().slice(0,120)}`); });
    
    await pgA.goto(`${BASE}?room=${room}`);
    await pgB.goto(`${BASE}?room=${room}`);
    
    await pgA.fill('#my-name', 'alice');
    await pgA.click('#join-btn');
    await pgA.locator('#app-screen').waitFor({ state: 'visible', timeout: 8000 });
    console.log('Alice app screen visible');
    
    await pgB.fill('#my-name', 'bob');
    await pgB.click('#join-btn');
    console.log('Bob join clicked');
    
    await new Promise(r => setTimeout(r, 8000));
    
    const count = await pgA.locator('.peer-item').count();
    console.log(`\nResult: Alice peer items = ${count}`);
    await browser.close();
})().catch(e => { console.error(e.message); process.exit(1); });
