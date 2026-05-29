// FileManager — chunked file transfer over the 'file' DataChannel
// Protocol:
//   sender  → JSON       { type:'file-start', id, name, size, mime, totalChunks }
//   sender  → ArrayBuffer  [40-byte header: 36-byte UUID + 4-byte chunkIndex LE] + chunk data
//   sender  → JSON       { type:'file-end', id }
//   receiver emits 'file-received' CustomEvent { name, mime, blob, from }
//   sender   emits 'progress'      CustomEvent { id, name, sent, total, peerId }
//
// Requires: peerManager must set channel.binaryType = 'arraybuffer' on the 'file'
// DataChannel so binary frames arrive as ArrayBuffer (default binaryType is 'blob').
// Total binary header = 40 bytes per chunk (ID_BYTES=36 + 4 index bytes).

const CHUNK_SIZE   = 16 * 1024; // 16 KB — safe SCTP single-message limit
const ID_BYTES     = 36;        // full UUID string length (e.g. "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx")
// Back-pressure: pause sending when the DataChannel buffer exceeds HIGH_WATER;
// resume when it drains below LOW_WATER (H6 — prevents send-queue overflow on slow links).
const BUFFER_HIGH  = 1024 * 1024;   // 1 MB
const BUFFER_LOW   = 256 * 1024;    // 256 KB
const BUFFER_DRAIN_TIMEOUT = 10000; // 10 s max wait before giving up

function idPrefix(uuid) {
  // 36 ASCII chars of the UUID → 36 bytes Uint8Array
  const bytes = new Uint8Array(ID_BYTES);
  for (let i = 0; i < ID_BYTES; i++) bytes[i] = uuid.charCodeAt(i);
  return bytes;
}

function encodeChunk(uuid, index, arrayBuffer) {
  const header = new ArrayBuffer(ID_BYTES + 4);
  new Uint8Array(header).set(idPrefix(uuid));
  new DataView(header).setUint32(ID_BYTES, index, true /* little-endian */);
  const out = new Uint8Array(header.byteLength + arrayBuffer.byteLength);
  out.set(new Uint8Array(header), 0);
  out.set(new Uint8Array(arrayBuffer), header.byteLength);
  return out.buffer;
}

function decodeHeader(arrayBuffer) {
  const view = new DataView(arrayBuffer);
  const prefix = new Uint8Array(arrayBuffer, 0, ID_BYTES);
  const id = Array.from(prefix).map((b) => String.fromCharCode(b)).join('');
  const index = view.getUint32(ID_BYTES, true);
  const data = arrayBuffer.slice(ID_BYTES + 4);
  return { id, index, data };
}

export class FileManager extends EventTarget {
  constructor(peerManager) {
    super();
    this._pm = peerManager;
    // active outbound transfers: id → { name, totalChunks, sent }
    this._outbound = new Map();
    // active inbound transfers: id → { name, mime, size, totalChunks, chunks: Map<index, ArrayBuffer> }
    this._inbound = new Map();

    peerManager.addEventListener('message', (e) => {
      const { peerId, label, data } = e.detail;
      if (label !== 'file') return;

      if (typeof data === 'string') {
        this._handleControl(peerId, data);
      } else {
        this._handleChunk(peerId, data);
      }
    });
  }

  // Send a File object to a specific peer.
  // Optional transferId: pre-generate in the UI so progress bubbles can be keyed
  // before the first progress event fires, avoiding a listener-order race.
  async sendFile(peerId, file, transferId = null) {
    const id = transferId || crypto.randomUUID();
    const buffer = await file.arrayBuffer();
    const totalChunks = Math.ceil(buffer.byteLength / CHUNK_SIZE);

    this._outbound.set(id, { name: file.name, totalChunks, sent: 0 });

    // Send metadata frame
    const startMsg = JSON.stringify({
      type: 'file-start',
      id,
      name: file.name,
      size: file.size,
      mime: file.type || 'application/octet-stream',
      totalChunks,
    });
    this._pm.safeSend(peerId, 'file', startMsg);

    // Send binary chunks
    for (let i = 0; i < totalChunks; i++) {
      // Back-pressure: wait if the DataChannel send buffer is too full (H6).
      const channel = this._pm.getChannel(peerId, 'file');
      if (!channel || channel.readyState !== 'open') break; // peer disconnected

      if (channel.bufferedAmount > BUFFER_HIGH) {
        channel.bufferedAmountLowThreshold = BUFFER_LOW;
        await new Promise((resolve) => {
          const timeout = setTimeout(resolve, BUFFER_DRAIN_TIMEOUT);
          const onLow = () => {
            clearTimeout(timeout);
            channel.removeEventListener('bufferedamountlow', onLow);
            resolve();
          };
          channel.addEventListener('bufferedamountlow', onLow);
        });
        // Re-check after waiting — peer may have disconnected during the wait
        if (this._pm.getChannel(peerId, 'file')?.readyState !== 'open') break;
      }

      const start = i * CHUNK_SIZE;
      const chunk = buffer.slice(start, start + CHUNK_SIZE);
      const frame = encodeChunk(id, i, chunk);
      this._pm.safeSend(peerId, 'file', frame);

      const transfer = this._outbound.get(id);
      if (transfer) {
        transfer.sent = i + 1;
        this.dispatchEvent(new CustomEvent('progress', {
          detail: { id, name: file.name, sent: transfer.sent, total: totalChunks, peerId },
        }));
      }
      // Yield to the event loop between chunks to avoid monopolising the DataChannel
      await new Promise((r) => setTimeout(r, 0));
    }

    // Send end frame
    this._pm.safeSend(peerId, 'file', JSON.stringify({ type: 'file-end', id }));
    this._outbound.delete(id);
  }

  _handleControl(peerId, raw) {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    if (msg.type === 'file-start') {
      this._inbound.set(msg.id, {
        name: msg.name,
        mime: msg.mime,
        size: msg.size,
        totalChunks: msg.totalChunks,
        chunks: new Map(),
        from: peerId,
      });
      this.dispatchEvent(new CustomEvent('transfer-start', {
        detail: { id: msg.id, name: msg.name, size: msg.size, mime: msg.mime, from: peerId },
      }));
    }

    if (msg.type === 'file-end') {
      const transfer = this._inbound.get(msg.id);
      if (!transfer) return;
      this._inbound.delete(msg.id);

      const sortedChunks = Array.from({ length: transfer.totalChunks }, (_, i) => transfer.chunks.get(i))
        .filter(Boolean);
      const blob = new Blob(sortedChunks, { type: transfer.mime });

      this.dispatchEvent(new CustomEvent('file-received', {
        detail: { id: msg.id, name: transfer.name, mime: transfer.mime, blob, from: transfer.from },
      }));
    }
  }

  _handleChunk(peerId, arrayBuffer) {
    if (arrayBuffer.byteLength < ID_BYTES + 4) return; // too small to be a valid chunk
    const { id, index, data } = decodeHeader(arrayBuffer);
    const transfer = this._inbound.get(id);
    if (!transfer) return;

    transfer.chunks.set(index, data);

    this.dispatchEvent(new CustomEvent('progress', {
      detail: {
        id,
        name: transfer.name,
        received: transfer.chunks.size,
        total: transfer.totalChunks,
        peerId,
      },
    }));
  }

  // Abort all inbound transfers from a peer that disconnected
  peerLeft(peerId) {
    for (const [id, transfer] of this._inbound) {
      if (transfer.from === peerId) {
        this._inbound.delete(id);
        this.dispatchEvent(new CustomEvent('transfer-aborted', { detail: { id, peerId } }));
      }
    }
  }
}
