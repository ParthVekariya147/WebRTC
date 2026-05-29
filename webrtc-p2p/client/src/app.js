// app.js — Phase 4.5: sender preview, multi-file staging, inline receive previews, drag-and-drop
import { SIGNALING_URL } from './config.js';
import { SignalingClient } from './signalingClient.js';
import { PeerManager } from './peerManager.js';
import { ChatManager } from './chatManager.js';
import { FileManager } from './fileManager.js';
import { log } from './logger.js';

if (typeof location !== 'undefined'
    && location.protocol === 'https:'
    && SIGNALING_URL.startsWith('ws://')) {
    log.error('SECURITY: signaling URL uses ws:// on an HTTPS page. Set VITE_SIGNALING_URL to wss://');
    console.warn('[p2p] Mixed-content: signaling URL is ws:// but page is HTTPS. Connections will be blocked.');
}

export const ROOM_ID = '__room__';

const FILE_SIZE_WARN  = 100 * 1024 * 1024;  // 100 MB
const FILE_SIZE_MAX   = 500 * 1024 * 1024;  // 500 MB hard limit
const BATCH_SIZE_WARN = 200 * 1024 * 1024;  // 200 MB combined warn

// ── State ──────────────────────────────────────────────────────────────────
let myName = '', roomId = '';
let signaling = null, peerManager = null, chatManager = null, fileManager = null;
let conversations = {};
let activePeerId = null;
let pendingFiles = [];  // [{ id, file, previewUrl }]
let joined = false;
const activeTransfers = new Map();
const _blobUrls = [];

// ── Pure helpers (exported for tests) ──────────────────────────────────────
export function fileCategory(mime = '', name = '') {
    if (mime.startsWith('image/')) return 'image';
    if (mime.startsWith('video/')) return 'video';
    if (mime.startsWith('audio/')) return 'audio';
    if (mime === 'application/pdf' || name.toLowerCase().endsWith('.pdf')) return 'pdf';
    return 'other';
}

export function fmtSize(bytes) {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
    return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

function catIcon(cat) {
    const m = { image: 'fa-solid fa-image', video: 'fa-solid fa-film', audio: 'fa-solid fa-music', pdf: 'fa-solid fa-file-pdf' };
    return m[cat] || 'fa-solid fa-file';
}

// ── Theme toggle ───────────────────────────────────────────────────────────
window.toggleTheme = function () {
    const html = document.documentElement;
    const isDark = html.getAttribute('data-theme') === 'dark';
    html.setAttribute('data-theme', isDark ? 'light' : 'dark');
    document.getElementById('theme-icon').className = isDark ? 'fa-solid fa-moon' : 'fa-solid fa-sun';
    localStorage.setItem('theme', isDark ? 'light' : 'dark');
};

(function () {
    const saved = localStorage.getItem('theme');
    if (saved === 'dark') {
        document.documentElement.setAttribute('data-theme', 'dark');
        document.getElementById('theme-icon').className = 'fa-solid fa-sun';
    }
})();

// ── Login ──────────────────────────────────────────────────────────────────
window.joinRoom = function () {
    myName = document.getElementById('my-name').value.trim();
    roomId = document.getElementById('room-id').value.trim();
    if (!myName || !roomId) { loginStatus('Name and Room ID are required.', true); return; }

    loginStatus('Connecting…');
    signaling   = new SignalingClient(SIGNALING_URL);
    peerManager = new PeerManager(myName, signaling);
    chatManager = new ChatManager(peerManager);
    fileManager = new FileManager(peerManager);

    fileManager.addEventListener('transfer-start', ({ detail: { id, name, from } }) => {
        ensureConv(from);
        const entry = makeFileBubble('in', name, id);
        conversations[from].messages.push({ _fileXfer: true, id });
        if (activePeerId === from) {
            document.getElementById('messages-area').appendChild(entry.wrap);
            scrollEnd();
        }
    });

    fileManager.addEventListener('progress', ({ detail }) => {
        const entry = activeTransfers.get(detail.id);
        if (!entry) return;
        const pct = detail.sent != null
            ? Math.round((detail.sent / detail.total) * 100)
            : Math.round((detail.received / detail.total) * 100);
        entry.barEl.style.width = `${pct}%`;
        if (detail.sent != null) {
            entry.statusEl.textContent = pct >= 100 ? 'Sent ✓' : `Sending… ${pct}%`;
        } else {
            entry.statusEl.textContent = `Receiving… ${pct}%`;
        }
    });

    fileManager.addEventListener('file-received', ({ detail: { id, name, mime, blob, from } }) => {
        const entry = activeTransfers.get(id);
        if (entry) {
            const url = URL.createObjectURL(blob);
            _blobUrls.push(url);
            renderReceivedPreview(entry.contentEl, url, name, mime, blob.size);
            entry.barEl.style.width = '100%';
            entry.statusEl.textContent = 'Received ✓';
            activeTransfers.delete(id);
        }
        const conv = conversations[from];
        if (conv) { const m = conv.messages.find(x => x._fileXfer && x.id === id); if (m) m.name = name; }
        renderPeerList();
    });

    fileManager.addEventListener('transfer-aborted', ({ detail: { id } }) => {
        const entry = activeTransfers.get(id);
        if (entry) {
            entry.statusEl.textContent = 'Cancelled — peer disconnected';
            entry.barEl.style.opacity = '0.4';
            activeTransfers.delete(id);
        }
    });

    signaling.addEventListener('connected', () => { loginStatus('Joining room…'); signaling.join(roomId, myName); });
    signaling.addEventListener('error', (e) => loginStatus(e.detail.message || 'Server error', true));
    signaling.addEventListener('room-peers', () => {
        if (!joined) {
            joined = true;
            conversations[ROOM_ID] = { messages: [], unread: 0, status: 'room', isRoom: true };
            showApp();
        }
    });

    peerManager.addEventListener('channelopen', ({ detail: { peerId, label } }) => {
        dbg(`[CHANNEL] ${label} open ← ${peerId}`);
        ensureConv(peerId);
        conversations[peerId].status = 'online';
        sysMsg(peerId, `${peerId} joined`);
        renderPeerList();
        if (activePeerId === peerId) refreshChatTop(peerId);
    });

    peerManager.addEventListener('peerleft', ({ detail: { peerId } }) => {
        dbg(`[PEER LEFT] ${peerId}`);
        fileManager?.peerLeft(peerId);
        if (!conversations[peerId]) return;
        conversations[peerId].status = 'offline';
        sysMsg(peerId, `${peerId} left`);
        renderPeerList();
        if (activePeerId === peerId) refreshChatTop(peerId);
    });

    peerManager.addEventListener('icestate', ({ detail: { peerId, state } }) => {
        dbg(`[ICE:${peerId.slice(0,8)}] ${state}`);
        if (activePeerId !== peerId) return;
        const bar = document.getElementById('ice-bar');
        if (state === 'checking') {
            bar.innerHTML = '<i class="fa-solid fa-circle-notch fa-spin"></i> &nbsp;Establishing direct connection…';
            bar.classList.add('visible');
        } else if (state === 'connected') {
            bar.innerHTML = '<i class="fa-solid fa-circle-check"></i> &nbsp;Direct P2P connection established';
            bar.classList.add('visible');
            setTimeout(() => bar.classList.remove('visible'), 3000);
        } else if (state === 'failed') {
            bar.innerHTML = '<i class="fa-solid fa-triangle-exclamation"></i> &nbsp;Direct connection failed — check network.';
            bar.classList.add('visible');
        } else {
            bar.classList.remove('visible');
        }
    });

    chatManager.addEventListener('message', ({ detail: msg }) => {
        const isMe = msg.from === myName;
        const isBroadcast = !msg.to;
        const convKey = isBroadcast ? ROOM_ID : (isMe ? msg.to : msg.from);
        ensureConv(convKey);
        const bubble = { sender: isMe ? 'me' : 'them', text: msg.text, time: fmt(msg.ts) };
        conversations[convKey].messages.push(bubble);
        if (activePeerId === convKey) appendBubble(bubble);
        else if (!isMe) conversations[convKey].unread++;
        renderPeerList();
    });
};

window.addEventListener('beforeunload', () => {
    peerManager?.destroy();
    signaling?.destroy();
    _blobUrls.forEach(url => URL.revokeObjectURL(url));
    _blobUrls.length = 0;
    pendingFiles.forEach(f => { if (f.previewUrl) URL.revokeObjectURL(f.previewUrl); });
    pendingFiles = [];
});

// ── Show app ───────────────────────────────────────────────────────────────
function showApp() {
    document.getElementById('login-screen').classList.remove('active');
    document.getElementById('app-screen').classList.add('active');
    document.getElementById('display-my-name').textContent = myName;
    document.getElementById('display-room-id').textContent = roomId;
    setupDragDrop();
}

function loginStatus(msg, isError = false) {
    const el = document.getElementById('login-status');
    el.textContent = msg;
    el.className = isError ? 'error' : '';
    if (isError) {
        const btn = document.getElementById('join-btn');
        if (btn) { btn.disabled = false; btn.innerHTML = '<i class="fa-solid fa-arrow-right-to-bracket"></i> &nbsp;Join Room'; }
    }
}

// ── Drag-and-drop ──────────────────────────────────────────────────────────
function setupDragDrop() {
    const area = document.getElementById('messages-area');

    area.addEventListener('dragover', (e) => {
        e.preventDefault();
        if (!activePeerId || activePeerId === ROOM_ID) return;
        area.classList.add('drag-over');
    });

    area.addEventListener('dragleave', (e) => {
        if (!area.contains(e.relatedTarget)) area.classList.remove('drag-over');
    });

    area.addEventListener('drop', (e) => {
        e.preventDefault();
        area.classList.remove('drag-over');
        if (!activePeerId || activePeerId === ROOM_ID) return;
        const files = Array.from(e.dataTransfer.files || []);
        if (files.length) addFilesToPending(files);
    });
}

// ── Conversations ──────────────────────────────────────────────────────────
function ensureConv(peerId) {
    if (!conversations[peerId]) conversations[peerId] = { messages: [], unread: 0, status: 'connecting' };
}

function sysMsg(peerId, text) {
    ensureConv(peerId);
    conversations[peerId].messages.push({ sys: true, text });
    if (activePeerId === peerId) {
        const d = document.createElement('div');
        d.className = 'sys-msg'; d.textContent = text;
        document.getElementById('messages-area').appendChild(d);
        scrollEnd();
    }
}

// ── Peer list ──────────────────────────────────────────────────────────────
function renderPeerList() {
    const list  = document.getElementById('peer-list');
    const empty = document.getElementById('peer-list-empty');
    const roomConv = conversations[ROOM_ID];
    const peerIds  = Object.keys(conversations).filter(k => k !== ROOM_ID);

    if (!roomConv && peerIds.length === 0) { empty.style.display = ''; return; }
    empty.style.display = 'none';
    Array.from(list.children).forEach(c => { if (c !== empty) c.remove(); });

    if (roomConv) {
        const onlinePeerCount = peerIds.filter(p => conversations[p]?.status === 'online').length;
        const lastRoom = [...roomConv.messages].reverse().find(m => !m.sys);
        const roomPreview = lastRoom ? lastRoom.text : (onlinePeerCount ? `${onlinePeerCount} peer${onlinePeerCount > 1 ? 's' : ''} online` : 'Waiting for peers…');
        const d = document.createElement('div');
        d.className = `peer-item room-item${activePeerId === ROOM_ID ? ' active' : ''}`;
        d.onclick = () => openChat(ROOM_ID);
        d.innerHTML = `
            <div class="avatar group"><i class="fa-solid fa-users"></i></div>
            <div class="peer-info">
                <div class="peer-name">Room — everyone</div>
                <div class="peer-preview">${esc(roomPreview)}</div>
            </div>
            <div class="peer-meta">
                ${lastRoom ? `<div class="peer-time">${lastRoom.time}</div>` : ''}
                ${roomConv.unread > 0 ? `<div class="unread-dot">${roomConv.unread > 99 ? '99+' : roomConv.unread}</div>` : ''}
            </div>`;
        list.appendChild(d);
    }

    peerIds.forEach((pid) => {
        const conv = conversations[pid];
        const last = [...conv.messages].reverse().find(m => !m.sys);
        const preview = last ? (last.media ? '📎 File' : last.text) : 'No messages yet';
        const isOnline = conv.status === 'online';
        const d = document.createElement('div');
        d.className = `peer-item${activePeerId === pid ? ' active' : ''}`;
        d.onclick = () => openChat(pid);
        d.innerHTML = `
            <div class="avatar ${isOnline ? 'online' : ''}"><i class="fa-solid fa-user"></i></div>
            <div class="peer-info">
                <div class="peer-name">${esc(pid)}</div>
                <div class="peer-preview">${esc(preview)}</div>
            </div>
            <div class="peer-meta">
                ${last ? `<div class="peer-time">${last.time}</div>` : ''}
                <div class="status-dot ${isOnline ? '' : 'offline'}"></div>
                ${conv.unread > 0 ? `<div class="unread-dot">${conv.unread > 99 ? '99+' : conv.unread}</div>` : ''}
            </div>`;
        list.appendChild(d);
    });
}

// ── Open chat ──────────────────────────────────────────────────────────────
function openChat(peerId) {
    activePeerId = peerId;
    conversations[peerId].unread = 0;
    document.getElementById('no-chat-overlay').style.display = 'none';
    document.getElementById('chat-top').style.display  = 'flex';
    document.getElementById('input-row').classList.add('visible');
    refreshChatTop(peerId);
    const area = document.getElementById('messages-area');
    area.innerHTML = '';
    conversations[peerId].messages.forEach((m) => {
        if (m.sys) { const d = document.createElement('div'); d.className = 'sys-msg'; d.textContent = m.text; area.appendChild(d); }
        else appendBubble(m, false);
    });
    scrollEnd();
    renderPeerList();
    document.getElementById('msg-input').focus();
}

function refreshChatTop(peerId) {
    const conv = conversations[peerId];
    const isRoom = peerId === ROOM_ID;
    const nameEl = document.getElementById('active-peer-name');
    const st     = document.getElementById('active-peer-status');
    const av     = document.getElementById('chat-top-avatar');

    if (isRoom) {
        const onlineCount = Object.keys(conversations)
            .filter(k => k !== ROOM_ID && conversations[k]?.status === 'online').length;
        nameEl.textContent = 'Room — everyone';
        st.textContent = onlineCount ? `${onlineCount} peer${onlineCount > 1 ? 's' : ''} connected` : 'No peers connected';
        st.className = onlineCount ? 'online' : '';
        av.className = 'avatar group';
        return;
    }

    const isOnline = conv?.status === 'online';
    nameEl.textContent = peerId;
    st.textContent = isOnline ? 'Online — Direct P2P' : (conv?.status === 'connecting' ? 'Connecting…' : 'Offline');
    st.className = isOnline ? 'online' : (conv?.status === 'offline' ? 'offline' : '');
    av.className = `avatar ${isOnline ? 'online' : ''}`;
}

// ── Render bubble ──────────────────────────────────────────────────────────
function appendBubble(msg, scroll = true) {
    const area = document.getElementById('messages-area');
    const wrap = document.createElement('div');
    wrap.className = `message ${msg.sender === 'me' ? 'out' : 'in'}`;

    let html = '<div class="bubble">';
    if (msg.media) {
        const blob = new Blob([msg.media.blob], { type: msg.media.fileType });
        const url  = URL.createObjectURL(blob);
        _blobUrls.push(url);
        html += '<div class="media-wrap">';
        if      (msg.media.fileType.startsWith('image/')) html += `<img src="${url}" alt="${esc(msg.media.fileName)}" onload="URL.revokeObjectURL(this.src)">`;
        else if (msg.media.fileType.startsWith('video/')) html += `<video controls src="${url}" onloadeddata="URL.revokeObjectURL(this.src)"></video>`;
        else if (msg.media.fileType.startsWith('audio/')) html += `<audio controls src="${url}" onloadeddata="URL.revokeObjectURL(this.src)"></audio>`;
        else html += `<a class="file-link" href="${url}" download="${esc(msg.media.fileName)}" onclick="setTimeout(()=>URL.revokeObjectURL(this.href),1000)"><i class="fa-solid fa-file-arrow-down"></i> ${esc(msg.media.fileName)}</a>`;
        html += '</div>';
    }
    if (msg.text) html += `<span>${esc(msg.text)}</span>`;
    html += `<div class="bubble-footer"><span class="msg-time">${msg.time}</span></div></div>`;

    wrap.innerHTML = html;
    area.appendChild(wrap);
    if (scroll) scrollEnd();
}

// ── Received file preview renderer ─────────────────────────────────────────
function renderReceivedPreview(contentEl, url, name, mime, size) {
    const cat = fileCategory(mime, name);
    if (cat === 'image') {
        const img = document.createElement('img');
        img.src = url;
        img.className = 'received-img';
        img.alt = esc(name);
        img.title = 'Click to enlarge';
        img.onclick = () => openLightbox(url, name);
        contentEl.appendChild(img);
    } else if (cat === 'video') {
        const vid = document.createElement('video');
        vid.src = url;
        vid.controls = true;
        vid.className = 'received-video';
        contentEl.appendChild(vid);
    } else if (cat === 'audio') {
        const aud = document.createElement('audio');
        aud.src = url;
        aud.controls = true;
        aud.className = 'received-audio';
        contentEl.appendChild(aud);
    } else if (cat === 'pdf') {
        const wrap = document.createElement('div');
        wrap.className = 'received-file-actions';
        wrap.innerHTML = `
            <a class="file-action-btn" href="${url}" target="_blank" rel="noopener noreferrer">
                <i class="fa-solid fa-eye"></i> View
            </a>
            <a class="file-action-btn" href="${url}" download="${esc(name)}">
                <i class="fa-solid fa-file-arrow-down"></i> Download
            </a>`;
        contentEl.appendChild(wrap);
    } else {
        const link = document.createElement('a');
        link.className = 'file-xfer-link';
        link.href = url;
        link.download = esc(name);
        link.innerHTML = `<i class="fa-solid fa-file-arrow-down"></i> ${esc(name)} <span class="file-xfer-size">(${fmtSize(size)})</span>`;
        link.addEventListener('click', () => setTimeout(() => {
            const idx = _blobUrls.indexOf(url);
            if (idx !== -1) { URL.revokeObjectURL(url); _blobUrls.splice(idx, 1); }
        }, 1000));
        contentEl.appendChild(link);
    }
}

// ── Send message ───────────────────────────────────────────────────────────
window.sendMessage = function () {
    if (!activePeerId || !peerManager) return;

    const input = document.getElementById('msg-input');
    const text  = input.value.trim();
    input.value = '';
    input.focus();

    if (!text && !pendingFiles.length) return;

    if (activePeerId === ROOM_ID) {
        if (pendingFiles.length) {
            sysMsg(ROOM_ID, 'To send files, select a specific peer from the sidebar.');
            clearAttachment();
        }
        if (text) {
            const onlinePeers = peerManager.getPeerIds().filter(
                pid => peerManager.getChannel(pid, 'chat')?.readyState === 'open'
            );
            if (onlinePeers.length === 0) { sysMsg(ROOM_ID, 'No peers online — message not sent.'); return; }
            chatManager.send(text);
        }
        renderPeerList();
        return;
    }

    const conv = conversations[activePeerId];
    if (conv?.status !== 'online') { sysMsg(activePeerId, 'Peer is offline — message not sent.'); return; }

    if (text) {
        const sent = peerManager.safeSend(activePeerId, 'chat', JSON.stringify({
            type: 'chat', id: crypto.randomUUID(),
            from: myName, to: activePeerId, text, ts: Date.now(),
        }));
        if (!sent) { sysMsg(activePeerId, 'Message not delivered — connection lost. Try again.'); return; }
        const bubble = { sender: 'me', text, time: fmt(Date.now()) };
        conv.messages.push(bubble);
        appendBubble(bubble);
    }

    if (pendingFiles.length) sendAllPendingFiles();

    renderPeerList();
};

async function sendAllPendingFiles() {
    if (!activePeerId || activePeerId === ROOM_ID) return;
    const conv = conversations[activePeerId];
    if (conv?.status !== 'online') return;

    const filesToSend = [...pendingFiles];
    clearAttachment();

    const area = document.getElementById('messages-area');
    const entries = filesToSend.map(({ id, file }) => {
        const entry = makeFileBubble('out', file.name, id);
        conv.messages.push({ _fileXfer: true, sender: 'me', id });
        area.appendChild(entry.wrap);
        return { id, file, entry };
    });
    scrollEnd();

    for (const { id, file, entry } of entries) {
        try {
            await fileManager.sendFile(activePeerId, file, id);
            if (!entry.statusEl.textContent.includes('✓')) entry.statusEl.textContent = 'Sent ✓';
            entry.barEl.style.width = '100%';
        } catch (err) {
            entry.statusEl.textContent = 'Send failed';
            log.error('[file] sendFile error:', err);
        }
    }
}

// ── File transfer bubble factory ───────────────────────────────────────────
function makeFileBubble(direction, name, id) {
    const wrap = document.createElement('div');
    wrap.className = `message ${direction === 'out' ? 'out' : 'in'}`;

    const bubble = document.createElement('div');
    bubble.className = 'bubble';

    const xfer = document.createElement('div');
    xfer.className = 'file-xfer';

    const nameEl = document.createElement('div');
    nameEl.className = 'file-xfer-name';
    nameEl.innerHTML = `<i class="fa-solid fa-file"></i>${esc(name)}`;

    const barWrap = document.createElement('div');
    barWrap.className = 'file-xfer-bar-wrap';
    const barEl = document.createElement('div');
    barEl.className = 'file-xfer-bar';
    barWrap.appendChild(barEl);

    const statusEl = document.createElement('div');
    statusEl.className = 'file-xfer-status';
    statusEl.textContent = direction === 'out' ? 'Sending… 0%' : 'Receiving… 0%';

    const contentEl = document.createElement('div');
    contentEl.className = 'file-xfer-content';

    const footer = document.createElement('div');
    footer.className = 'bubble-footer';
    footer.innerHTML = `<span class="msg-time">${fmt(Date.now())}</span>`;

    xfer.appendChild(nameEl);
    xfer.appendChild(barWrap);
    xfer.appendChild(statusEl);
    xfer.appendChild(contentEl);
    bubble.appendChild(xfer);
    bubble.appendChild(footer);
    wrap.appendChild(bubble);

    const entry = { wrap, barEl, statusEl, contentEl };
    if (id) activeTransfers.set(id, entry);
    return entry;
}

// ── File selection & staging ────────────────────────────────────────────────
window.handleFileSelect = function (input) {
    const files = Array.from(input.files || []);
    if (files.length) addFilesToPending(files);
    input.value = '';
};

function addFilesToPending(files) {
    let skipped = 0;
    for (const file of files) {
        if (file.size > FILE_SIZE_MAX) { skipped++; continue; }
        const id = crypto.randomUUID();
        const cat = fileCategory(file.type, file.name);
        const previewUrl = (cat === 'image' || cat === 'video') ? URL.createObjectURL(file) : null;
        pendingFiles.push({ id, file, previewUrl });
    }
    if (skipped && activePeerId) {
        sysMsg(activePeerId, `${skipped} file${skipped > 1 ? 's' : ''} skipped — exceeds 500 MB limit.`);
    }
    renderFileStagePanel();
}

function renderFileStagePanel() {
    const panel = document.getElementById('file-stage-panel');
    if (!pendingFiles.length) { panel.classList.remove('visible'); return; }
    panel.classList.add('visible');

    const totalSize = pendingFiles.reduce((sum, f) => sum + f.file.size, 0);
    const hasLargeFile = pendingFiles.some(f => f.file.size > FILE_SIZE_WARN);
    const hasBatchWarn = totalSize > BATCH_SIZE_WARN;

    const listEl = document.getElementById('file-stage-list');
    listEl.innerHTML = '';

    for (const { id, file, previewUrl } of pendingFiles) {
        const cat = fileCategory(file.type, file.name);
        const item = document.createElement('div');
        item.className = 'file-stage-item';

        let thumbHtml = '';
        if (cat === 'image' && previewUrl) {
            thumbHtml = `<img src="${previewUrl}" class="file-stage-thumb-img" alt="">`;
        } else if (cat === 'video' && previewUrl) {
            thumbHtml = `<video src="${previewUrl}" class="file-stage-thumb-vid" muted preload="metadata"></video>`;
        } else {
            thumbHtml = `<i class="${catIcon(cat)} file-stage-thumb-icon"></i>`;
        }

        item.innerHTML = `
            <div class="file-stage-thumb">${thumbHtml}</div>
            <div class="file-stage-info">
                <div class="file-stage-name" title="${esc(file.name)}">${esc(file.name)}</div>
                <div class="file-stage-meta">${fmtSize(file.size)} · ${cat}</div>
            </div>
            <button class="file-stage-remove" onclick="removePendingFile('${id}')" title="Remove">
                <i class="fa-solid fa-xmark"></i>
            </button>`;
        listEl.appendChild(item);
    }

    document.getElementById('file-stage-count').textContent =
        `${pendingFiles.length} file${pendingFiles.length !== 1 ? 's' : ''} · ${fmtSize(totalSize)}`;

    const warnEl = document.getElementById('file-stage-warn');
    if (hasBatchWarn) {
        warnEl.textContent = '⚠️ Total > 200 MB — transfer may be slow.';
        warnEl.style.display = '';
    } else if (hasLargeFile) {
        warnEl.textContent = '⚠️ File > 100 MB — transfer may be slow.';
        warnEl.style.display = '';
    } else {
        warnEl.style.display = 'none';
    }
}

window.removePendingFile = function (id) {
    const idx = pendingFiles.findIndex(f => f.id === id);
    if (idx === -1) return;
    const { previewUrl } = pendingFiles[idx];
    if (previewUrl) URL.revokeObjectURL(previewUrl);
    pendingFiles.splice(idx, 1);
    renderFileStagePanel();
};

window.clearAttachment = function () {
    pendingFiles.forEach(f => { if (f.previewUrl) URL.revokeObjectURL(f.previewUrl); });
    pendingFiles = [];
    const input = document.getElementById('file-input');
    if (input) input.value = '';
    renderFileStagePanel();
};

// ── Lightbox ───────────────────────────────────────────────────────────────
function openLightbox(url, name) {
    const lb  = document.getElementById('lightbox');
    const img = document.getElementById('lightbox-img');
    img.src = url;
    img.alt = name || '';
    lb.classList.add('visible');
}

window.closeLightbox = function () {
    document.getElementById('lightbox').classList.remove('visible');
    document.getElementById('lightbox-img').src = '';
};

// ── Helpers ────────────────────────────────────────────────────────────────
export function fmt(ts) {
    return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function scrollEnd() {
    const a = document.getElementById('messages-area');
    a.scrollTop = a.scrollHeight;
}

export function esc(s) {
    if (!s) return '';
    return String(s)
        .replace(/&/g,  '&amp;')
        .replace(/</g,  '&lt;')
        .replace(/>/g,  '&gt;')
        .replace(/"/g,  '&quot;')
        .replace(/'/g,  '&#39;');
}

// ── Debug console ──────────────────────────────────────────────────────────
const _dbgLog = [];
function dbg(msg) {
    const ts = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    _dbgLog.push(`${ts}  ${msg}`);
    if (_dbgLog.length > 200) _dbgLog.shift();
    const el = document.getElementById('dbg-output');
    if (el) { el.textContent = _dbgLog.slice(-50).join('\n'); el.scrollTop = el.scrollHeight; }
}
window.toggleDebug = function () {
    const panel = document.getElementById('dbg-panel');
    panel.style.display = panel.style.display === 'none' ? 'block' : 'none';
};

(function () {
    const p = new URLSearchParams(location.search);
    if (p.get('room')) document.getElementById('room-id').value = p.get('room');
    if (p.get('name')) document.getElementById('my-name').value = p.get('name');
})();
