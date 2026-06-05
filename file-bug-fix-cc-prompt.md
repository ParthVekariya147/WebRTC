# CC Task: Fix receiver-side "undefined" file message bug

## Symptom
When a file is shared, the chat bubble for that file renders as **"undefined"** on the RECEIVER side, in both Room group chat and 1-on-1 chat. SENDER side renders correctly.

## Rule: diagnose before fixing
Do NOT change rendering code first. Instrument, capture, diff, THEN fix.

## Step 1 — Instrument (temporary logs)
Add labeled `console.log` at these 4 points and capture output from BOTH peers:

1. **Sender, when building the file chat message** (the object pushed to chat history / UI state). Log the full object + `Object.keys()`.
2. **Receiver, `file-meta` handler** — log the parsed meta object + keys.
3. **Receiver, `file-end` handler** — log the object passed to chat/UI when the file message is created or updated.
4. **The render function for a file bubble** — log the exact field it reads to display the name/label, and its value.

## Step 2 — Find the mismatch (most likely causes, check in order)
- **Field name mismatch (highest probability):** sender writes e.g. `name` / `fileName` / `text`, receiver reads a different key → `undefined`. Confirm the render function reads the SAME key the receiver writes.
- **Group vs 1-on-1 envelope drift:** Room broadcast path builds the message object differently from the 1-on-1 path, dropping the name field on one of them. Diff the two builders.
- **Race: file-end vs blob URL / UI update:** message object is pushed at `file-meta` time without name/URL, and the `file-end` update mutates an object that React/state does not treat as changed → no re-render with the real value. Confirm a NEW object/state update fires on `file-end`.
- **Sidebar preview logic** reading from a stale/empty transfer entry.

## Step 3 — Fix
- Make sender and receiver agree on ONE canonical field name for the display label (e.g. `fileName`). Update both builders + the render function.
- Ensure the file chat message carries `fileName`, `fileSize`, `mimeType`, `fileId`, and (on completion) the blob `url`.
- On `file-end`, push/replace the message with an immutable update so the UI re-renders.
- Apply the SAME message shape in Room and 1-on-1 paths (extract a single `buildFileMessage()` helper used by both).

## Step 4 — Verify
- Local 2-tab test: send image, PDF, video — receiver bubble shows correct name + inline preview, no "undefined".
- Same test in a 3-peer Room.
- Run test suite — keep all 91 passing; add a test asserting receiver file-message `fileName` is defined and equals sender's.
- Remove temporary logs.
- Commit + push, then verify on Vercel prod (account for Render cold start ~30–50s).

## Done criteria
No "undefined" on receiver in Room or 1-on-1; preview renders; suite green; verified in prod.
