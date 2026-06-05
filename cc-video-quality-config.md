# CC Task: Configure video for best *realistic* quality

## Principle
Quality is bounded by the weakest link. Use **caps (ceilings), not floors.** Let ABR degrade gracefully — fighting it with floors causes freezing, which looks worse. Do NOT add minBitrate. Do NOT hard-`min` resolution.

## Step 1 — Fix capture constraints (`client/src/mediaManager.js`)
Revert the hard floors added earlier. Use `ideal` only so capture never throws `OverconstrainedError` on weaker cameras:

```js
const VIDEO_CONSTRAINTS = {
  width:     { ideal: 1920 },
  height:    { ideal: 1080 },
  frameRate: { ideal: 30 },
  // NO min: — a hard min fails capture entirely if unmet
};
const AUDIO_CONSTRAINTS = {
  echoCancellation: true,
  noiseSuppression: true,
  autoGainControl:  true,
};
```
Remove any `min: 1280x720` / `minBitrate` left from the last change.

## Step 2 — Sender encoding params (where tracks are added, `peerManager.js` / after `setLocalStream`)
After adding the video track, set encoding params on the video sender:

```js
const sender = pc.getSenders().find(s => s.track && s.track.kind === 'video');
if (sender) {
  const params = sender.getParameters();
  if (!params.encodings || !params.encodings.length) params.encodings = [{}];
  params.encodings[0].maxBitrate = 5_000_000;        // 5 Mbps CEILING for 1080p
  // do NOT set minBitrate — let ABR float down
  params.degradationPreference = 'maintain-resolution'; // keep sharpness, drop fps first
  await sender.setParameters(params);
}
```

## Step 3 — Content hint on the track
```js
videoTrack.contentHint = 'detail';   // sharp/static; use 'motion' if mostly movement
```

## Step 4 — Prefer efficient codec (best quality per bitrate)
Where the transceiver is set up, prefer VP9/AV1 with H.264 fallback, guarded by feature detection:

```js
const caps = RTCRtpReceiver.getCapabilities('video');
if (caps && transceiver.setCodecPreferences) {
  const order = ['video/AV1', 'video/VP9', 'video/H264', 'video/VP8'];
  const sorted = [...caps.codecs].sort(
    (a, b) => order.indexOf(a.mimeType) - order.indexOf(b.mimeType)
  );
  transceiver.setCodecPreferences(sorted);
}
```
(AV1/VP9 = better quality at same bitrate but more CPU; fallback keeps weak devices working.)

## Step 5 — Verify
- Capture works on a low-end device / non-1080p webcam — **no OverconstrainedError**.
- Throttle network (DevTools → Network → Slow) → video **downscales smoothly**, does not freeze/disconnect.
- Cross-network test (your 5G phone + a peer on WiFi): connection establishes; if it fails to connect, that confirms TURN is needed (connection, not quality).
- Tests stay green; add an assertion that capture constraints contain no `min`.

## Done criteria
No floors anywhere; maxBitrate ceiling + degradationPreference + codec preference set; capture never throws on weak hardware; graceful downscale confirmed.
