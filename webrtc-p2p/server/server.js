// WebRTC P2P signaling server — Node.js + ws
// Role: route SDP and ICE between peers ONLY. Never touches media or data.
const http      = require('http');
const WebSocket = require('ws');

const PORT = process.env.PORT || 8080;

// L2: named constants — no magic numbers
const MAX_PEERS_PER_ROOM   = 5;         // mesh is at most 5×4/2 = 10 connections
const MAX_ID_LENGTH        = 64;        // roomId and peerId upper bound
const MAX_PAYLOAD_BYTES    = 64 * 1024; // 64 KB — covers any real SDP/ICE; blocks OOM (C1)
const MAX_ROOMS            = 1000;      // prevent unbounded room accumulation
const MAX_CONNECTIONS_PER_IP = 10;     // per-IP connection flood guard (H3)

// Lightweight HTTP server — only used for the Playwright /health readiness check.
// All real traffic is WebSocket.
const httpServer = http.createServer((req, res) => {
  if (req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('ok');
  } else {
    res.writeHead(404);
    res.end();
  }
});
httpServer.listen(PORT, () => {
  console.log(`Signaling server running on ws://localhost:${PORT}`);
});

// maxPayload rejects oversized frames at the transport level before any parsing (C1)
const wss = new WebSocket.Server({ server: httpServer, maxPayload: MAX_PAYLOAD_BYTES });

// rooms: Map<roomId, Map<peerId, WebSocket>>
const rooms = new Map();

// Per-IP connection count for flood protection (H3)
const connsByIp = new Map();

wss.on('connection', (ws, req) => {
  // Per-IP connection limit (H3)
  const ip = req.socket.remoteAddress || 'unknown';
  const ipCount = connsByIp.get(ip) || 0;
  if (ipCount >= MAX_CONNECTIONS_PER_IP) {
    ws.close(1008, 'Too many connections from your IP');
    return;
  }
  connsByIp.set(ip, ipCount + 1);

  let currentRoom = null;
  let currentPeerId = null;

  ws.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }

    if (msg.type === 'join') {
      const { roomId, peerId } = msg;

      // Basic validation
      if (!roomId || typeof roomId !== 'string' || roomId.length > MAX_ID_LENGTH) {
        ws.send(JSON.stringify({ type: 'error', message: 'Invalid roomId' }));
        return;
      }
      if (!peerId || typeof peerId !== 'string' || peerId.length > MAX_ID_LENGTH) {
        ws.send(JSON.stringify({ type: 'error', message: 'Invalid peerId' }));
        return;
      }

      // Reject duplicate peerId to prevent peer-left spoofing (H2)
      if (rooms.has(roomId) && rooms.get(roomId).has(peerId)) {
        ws.send(JSON.stringify({ type: 'error', message: 'Peer ID already in use' }));
        return;
      }

      // Cap total rooms to prevent memory exhaustion
      if (!rooms.has(roomId) && rooms.size >= MAX_ROOMS) {
        ws.send(JSON.stringify({ type: 'error', message: 'Server at capacity' }));
        return;
      }

      if (!rooms.has(roomId)) rooms.set(roomId, new Map());
      const room = rooms.get(roomId);

      if (room.size >= MAX_PEERS_PER_ROOM) {
        ws.send(JSON.stringify({ type: 'error', message: 'Room full' }));
        return;
      }

      // Send existing peer list to newcomer
      ws.send(JSON.stringify({ type: 'room-peers', peers: Array.from(room.keys()) }));

      // Notify existing peers
      room.forEach((peerWs) => {
        if (peerWs.readyState === WebSocket.OPEN) {
          peerWs.send(JSON.stringify({ type: 'peer-joined', peerId }));
        }
      });

      room.set(peerId, ws);
      currentRoom = roomId;
      currentPeerId = peerId;
      return;
    }

    // Route offer / answer / ice-candidate to target peer
    if (['offer', 'answer', 'ice-candidate'].includes(msg.type)) {
      if (!currentRoom) return;
      const room = rooms.get(currentRoom);
      if (!room) return;
      const targetWs = room.get(msg.to);
      if (targetWs && targetWs.readyState === WebSocket.OPEN) {
        // Overwrite the client-supplied 'from' with the authenticated sender ID (H1)
        // Prevents peer impersonation: a malicious client cannot forge who sent an offer.
        msg.from = currentPeerId;
        targetWs.send(JSON.stringify(msg));
      }
      return;
    }
  });

  ws.on('close', () => {
    // Release per-IP slot
    const remaining = (connsByIp.get(ip) || 1) - 1;
    if (remaining <= 0) connsByIp.delete(ip);
    else connsByIp.set(ip, remaining);

    if (!currentRoom || !currentPeerId) return;
    const room = rooms.get(currentRoom);
    if (!room) return;
    room.delete(currentPeerId);
    if (room.size === 0) rooms.delete(currentRoom);
    room.forEach((peerWs) => {
      if (peerWs.readyState === WebSocket.OPEN) {
        peerWs.send(JSON.stringify({ type: 'peer-left', peerId: currentPeerId }));
      }
    });
  });

  ws.on('error', (err) => {
    console.error('[server] WebSocket error:', err.message);
  });
});

module.exports = { wss, rooms };
