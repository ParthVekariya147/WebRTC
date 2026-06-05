# WebRTC P2P — Master Task List & Build Plan

Derived from the technical documentation (Modules 1–2, §06/07/12/13) and current repo state.
Repo: `ParthVekariya147/WebRTC` · monorepo `webrtc-p2p/{client,server}`.

**Already done (do not rebuild):** signaling server, mesh wiring, Perfect Negotiation, DataChannel router, file transfer, chat, file-bubble bug fix (106 tests), Privacy/ToS pages.

**Hard WebRTC plumbing already in `peerManager.js`:** `onnegotiationneeded` (guarded), `ontrack` → `track` event, `setLocalStream()`, glare/rollback. Video builds on top of this — no negotiation rewrite needed.

Legend: **D#** = decision point, approve before proceeding. Each task lists file · test · done-criteria.

---

## PHASE 5A — Module 1: One-Way Video/Audio (Broadcast)

Lowest risk, ships first. One peer captures + broadcasts; others receive-only.

### D1 — Confirm scope
Broadcast = presenter sends camera+mic, receivers play only. Approve before build.

### Tasks
1. **Media capture util** · `client/src/mediaManager.js` (new) · unit test
   - `getLocalStream({video, audio})` wrapping `getUserMedia`; handle `NotAllowedError`, `NotFoundError`, `NotReadableError` with the user-facing messages from §12.5.
   - 720p constraints (§6.2). Done: returns stream or typed error.
2. **Wire stream into mesh** · `peerManager.js` (use existing `setLocalStream`)
   - Presenter calls `setLocalStream(stream)` → `addTrack` fires `onnegotiationneeded` → renegotiation flows through existing Perfect Negotiation. Done: receivers get `track` event.
3. **Receiver video render** · `app.js` + `app.html`
   - On `track` event, create/attach `<video autoplay playsinline>` (playsinline required for iOS). Done: remote video plays.
4. **Presenter controls** · `app.js`/`app.html`
   - Start/Stop broadcast, mute mic (`track.enabled=false`, no renegotiation), pause video. Done: toggles work without dropping connection.
5. **Tests** · `mediaManager.test.js`, extend `peerManager.test.js`
   - Mock `getUserMedia`; assert track added → negotiation fires; assert error mapping. Done: suite green.

### D2 — Verify Module 1 in prod before Module 2
2-tab + cross-network test. Approve before bidirectional.

---

## PHASE 5B — Module 2: Bidirectional Video Call (Mesh)

Every peer sends + receives. Builds directly on 5A.

### Tasks
1. **Call lifecycle** · `app.js`
   - Start Call / Join Call / Leave Call. On start: every peer runs `setLocalStream()` so all send. Done: N-way call established.
2. **Video grid** · `app.js`/`app.html` + CSS · per §7.3
   - Local self-preview (`muted=true` to kill echo), N−1 remote tiles, auto-relayout `ceil(sqrt(n))` columns. Done: grid reflows on join/leave.
3. **Echo / audio** · capture constraints
   - `audio:{echoCancellation:true, noiseSuppression:true}`; self-preview muted. Done: no echo in 3-peer test.
4. **In-call controls** · toggle mic, toggle camera, leave, (optional) screen share via `replaceTrack` (§6.5). Done: controls don't renegotiate for mute; screen share swaps cleanly.
5. **Bandwidth cap** · use `setParameters()` (NOT SDP munging — already your pinned approach) to cap bitrate per network tier (1500/500/200 kbps). Done: bitrate honored.
6. **Cleanup on leave/peer-left** · stop local tracks, remove video tiles, close PCs. Done: no leaked streams/cameras-stay-on bug.
7. **Tests + e2e** · `e2e/phase5.spec.js`
   - Playwright: 2 then 3 peers, assert remote video tiles present, leave removes tile. Done: phase5 spec green.

### D3 — Mesh load check
At 4–5 peers w/ video, confirm upload (~4 Mbps/peer at 720p, §2.2) is acceptable on target devices. Decide max video peers.

---

## PHASE 5C — Reliability (from §12)

1. **ICE state UI** · surface connected/disconnected/failed per peer (§4.5, §12.1).
2. **Reconnect flow** · disconnected → 5s timer; failed → ICE restart (`iceRestart:true`); 10s no-resolve → close + re-signal (§12.2/12.3).
3. **Mid-call peer-left** · tile removal already wired in 5B; confirm under network drop.
   Done: drop one peer's network in test → others recover or cleanly remove.

---

## REMAINING LAUNCH BLOCKERS (parallel track, non-code or decision)

| # | Task | Type | Done-criteria |
|---|---|---|---|
| L1 | Cross-network test (post bug-fix) → decide if TURN needed | Test | File + chat verified across 2 real networks |
| L2 | TURN cost model | Spreadsheet/decision | Per-user/month estimate; pricing input ready |
| L3 | Safari/iOS real-hardware test | Test | Video call works on iOS Safari; `playsinline` verified |
| L4 | Recording strategy | Decision | Either client-side recording built OR "no-recording = privacy" positioned |
| L5 | Demo + landing page | Build | Live demo link + landing page (index.html exists — extend) |
| L6 | Production monitoring | Build | Active-rooms + connection-failure-rate dashboard/alerts |
| L7 | Fill legal `[BRACKETS]` + lawyer review | Legal | Privacy/ToS publishable |

---

## LATER — Mobile Migration (§13, do not start until web v1 ships)

1. Extract WebRTC core (PeerManager, Signaling, Chat, File) into DOM-free lib.
2. Define `MediaProvider` / `VideoRenderer` / `FileStorage` interfaces.
3. `react-native-webrtc`; `<video>`→`RTCView`, `crypto.randomUUID`→`uuid`, file save→`react-native-fs`.
4. iOS background-audio (AVAudioSession), screen-share via ReplayKit, no Expo Go (custom dev build).

---

## Suggested execution order
5A (D1→D2) → 5B (D3) → 5C → L1/L3 in parallel → L2/L4/L5/L6/L7 → mobile.

Hand each PHASE block to CC as its own task. Approve each D# before CC proceeds.
