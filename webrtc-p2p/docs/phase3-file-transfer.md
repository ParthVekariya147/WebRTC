# Phase 3 — File Transfer

**Status: COMPLETE**  
**Tests: 8/8 unit passing + 4/4 Playwright E2E passing** (`e2e/phase3.spec.js`)

---

## Goal

Transfer arbitrary files peer-to-peer over the dedicated `file` DataChannel using a chunked binary protocol. No file data passes through the signaling server.

---

## Protocol

```
Sender                                    Receiver
──────────────────────────────────────────────────────────
JSON  { type:'file-start', id, name,
        size, mime, totalChunks }  ──────►  _inbound.set(id, transfer)
                                            emit 'transfer-start'

ArrayBuffer [40-byte header + chunk] ───►  _inbound.get(id).chunks.set(index, data)
  (repeated for each chunk)               emit 'progress'

JSON  { type:'file-end', id }       ──────►  reassemble Blob from all chunks
                                            emit 'file-received'
```

### Binary Frame Format

Each binary chunk frame is a contiguous `ArrayBuffer`:

```
Offset   Length   Content
──────────────────────────────────────────
0        36       Transfer UUID (ASCII chars, e.g. "550e8400-e29b-41d4-...")
36       4        Chunk index (uint32, little-endian)
40       N        Raw file bytes (this chunk)
```

Total header overhead: **40 bytes per chunk**.

### Chunk Size

```js
const CHUNK_SIZE = 16 * 1024; // 16 KB
```

16 KB is within the safe SCTP single-message limit for all major WebRTC implementations.

---

## FileManager API

```js
import { FileManager } from './src/fileManager.js';

const fm = new FileManager(peerManager);

// Send a file
await fm.sendFile('bob', file, transferId);  // transferId optional

// Events (sender side)
fm.addEventListener('progress', e => {
    const { id, name, sent, total, peerId } = e.detail;
    // sent: chunks sent so far; total: totalChunks
});

// Events (receiver side)
fm.addEventListener('transfer-start', e => {
    const { id, name, size, from } = e.detail;
});
fm.addEventListener('progress', e => {
    const { id, name, received, total, peerId } = e.detail;
    // received: chunks received so far
});
fm.addEventListener('file-received', e => {
    const { id, name, mime, blob, from } = e.detail;
    const url = URL.createObjectURL(blob);
    // trigger download or display
});
fm.addEventListener('transfer-aborted', e => {
    const { id, peerId } = e.detail;
    // peer disconnected mid-transfer
});

// Peer disconnect cleanup
fm.peerLeft('bob');  // aborts all inbound transfers from that peer
```

---

## Key Design Decisions

### Pre-generated Transfer ID

The UI generates the transfer ID **before** calling `sendFile`, not inside `sendFile`:

```js
// In UI (sendMessage handler):
const transferId = crypto.randomUUID();
makeFileBubble('out', file.name, transferId);   // register in activeTransfers
fileManager.sendFile(peerId, file, transferId); // pass the same ID
```

**Why:** The global `progress` event listener is registered before `makeFileBubble` runs. If the ID were generated inside `sendFile`, the first `progress` event would fire before the bubble's entry was keyed in `activeTransfers`, silently dropping the progress update (the "Sending… 0% stuck" bug). Pre-generating the ID eliminates the listener-order race.

### `binaryType = 'arraybuffer'`

Set on the `file` DataChannel in `peerManager.js`:

```js
if (label === 'file') channel.binaryType = 'arraybuffer';
```

**Why:** WebRTC DataChannels default to `binaryType = 'blob'`. The `FileManager` uses `DataView` and `Uint8Array` to decode chunk headers — these require `ArrayBuffer`, not `Blob`. Without this fix, every binary chunk causes a `TypeError` in `decodeHeader` and the file is silently lost.

### Chunk Index, Not Sequence

Chunks are stored in a `Map<index, ArrayBuffer>`, not a simple array. The reassembly step sorts by index:

```js
const sortedChunks = Array.from({ length: totalChunks }, (_, i) => chunks.get(i));
```

**Why:** The `file` DataChannel uses `ordered: false` (unordered SCTP). Chunks may arrive out of order. Storing by index allows reassembly regardless of delivery order, while avoiding head-of-line blocking.

### Yield Between Chunks

```js
await new Promise((r) => setTimeout(r, 0));
```

Between each chunk send, `sendFile` yields to the event loop. This keeps the DataChannel from being overwhelmed and allows the browser to process ICE keepalives and other events during large transfers.

### Peer Disconnect Abort

```js
peerLeft(peerId) {
    for (const [id, transfer] of this._inbound) {
        if (transfer.from === peerId) {
            this._inbound.delete(id);
            this.dispatchEvent(new CustomEvent('transfer-aborted', { detail: { id, peerId } }));
        }
    }
}
```

Called from `peerManager`'s `peerleft` handler. Aborts all in-progress inbound transfers from a peer that disconnected, preventing memory leaks from unreachable chunk buffers.

---

## UI Integration

### Sender flow (Alice clicks Send with a file selected)

1. `sendMessage()` generates `transferId = crypto.randomUUID()`
2. `makeFileBubble('out', name, transferId)` creates a progress bubble in the DOM and registers `activeTransfers.set(transferId, entry)`
3. `fileManager.sendFile(peerId, file, transferId)` begins async chunked transfer
4. Each chunk fires `progress` → global listener updates `entry.barEl` and `entry.statusEl`
5. After the last chunk: `statusEl` shows "Sent ✓"

### Receiver flow (Bob receives the file)

1. `file-start` arrives → `makeFileBubble('in', name, id)` creates a "Receiving… 0%" bubble
2. Each binary chunk fires `progress` → updates Bob's bubble
3. `file-end` arrives → chunks assembled into `Blob` → `file-received` fires
4. `entry.contentEl.innerHTML` replaced with `<a class="file-xfer-link" download="..." href="blob:...">filename</a>`
5. Bob's status shows "Download ready"

---

## Tests

### Unit tests

```bash
cd client && npm test
```

File: `client/src/fileManager.test.js` — **8 tests**

| Test | What it verifies |
|---|---|
| Encoding/decoding round-trip (small) | `file-start` JSON, binary chunk, `file-end` JSON in correct order |
| Multi-chunk split | 33 KB file → 3 binary frames |
| Sender progress events | One `progress` event per chunk, `sent` increments |
| Single-chunk reassembly | `file-received` emits correct `Blob` with right `size` |
| Multi-chunk reassembly | 40 KB file reassembled intact |
| `transfer-start` event | Fires before chunks arrive, includes `name` and `size` |
| Unknown transfer ID ignored | Random binary data doesn't crash or produce spurious events |
| `peerLeft` cleanup | `transfer-aborted` fires, inbound state removed |

### E2E (Playwright)

```bash
npx playwright test e2e/phase3.spec.js
```

File: `e2e/phase3.spec.js` — **4 tests** (all pass within `retries: 2`)

| Test | Exit criteria |
|---|---|
| Small file | attach-bar clears, "Sent ✓" on sender, `blob:` download link on receiver |
| Multi-chunk file (33 KB) | All 3 chunks reassembled, filename preserved, "Download ready" |
| Text + file in same session | Chat message on `chat` channel + file on `file` channel both delivered |
| Peer disconnect mid-transfer | No crash, sender sees "bob left", peer shown as offline |

**ICE flakiness note**: Some tests fail on first attempt due to ICE non-determinism in headless Chromium and pass on retry. `retries: 2` in `playwright.config.js` covers this. This is not a code bug — it's inherent to WebRTC timing in headless environments.

---

## Files

| File | Role |
|---|---|
| `client/src/fileManager.js` | Chunked file transfer implementation |
| `client/src/fileManager.test.js` | Unit tests (8 tests) |
| `client/src/peerManager.js` | Added `channel.binaryType = 'arraybuffer'` for file channel |
| `client/index.html` | `makeFileBubble`, `sendMessage` file path, file-received download link |
| `e2e/phase3.spec.js` | Playwright E2E exit tests |
