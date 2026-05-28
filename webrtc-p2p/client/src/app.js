// app.js — top-level application logic, extracted from index.html (M5)
// Exports: esc, fmt (pure helpers, testable in isolation)
import { SIGNALING_URL } from './config.js';
import { SignalingClient } from './signalingClient.js';
import { PeerManager } from './peerManager.js';
import { ChatManager } from './chatManager.js';
import { FileManager } from './fileManager.js';
import { log } from './logger.js';

// M4: Warn if the page is served over HTTPS but the signaling URL is plain ws://.
// Browsers block mixed active content, so this would silently fail in production.
if (typeof location !== 'undefined'
    && location.protocol === 'https:'
    && SIGNALING_URL.startsWith('ws://')) {
    log.error('SECURITY: signaling URL uses ws:// on an HTTPS page. Set VITE_SIGNALING_URL to wss://');
    console.warn('[p2p] Mixed-content: signaling URL is ws:// but page is HTTPS. Connections will be blocked.');
}

// Phase 4: sentinel key for the group/broadcast conversation
export const ROOM_ID = '__room__';

// ── State ──────────────────────────────────────────────────────────────────
let myName = '', roomId = '';
let signaling = null, peerManager = null, chatManager = null, fileManager = null;
// peerId → { messages: [], unread: 0, status: 'connecting'|'online'|'offline'|'room' }
let conversations = {};
let activePeerId = null;
let pendingFile = null;
let joined = false;
const activeTransfers = new Map();

// M3: track blob URLs so they can be revoked when no longer needed
const _blobUrls = [];

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

    fileManager.addEventListener('transfer-start', ({ detail: { id, name, size, from } }) => {
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
            _blobUrls.push(url); // M3: track for later revocation
            const link = document.createElement('a');
            link.className = 'file-xfer-link';
            link.href = url;
            link.download = esc(name);
            link.innerHTML = `<i class="fa-solid fa-file-arrow-down"></i> ${esc(name)}`;
            // M3: revoke the blob URL after the browser starts the download
            link.addEventListener('click', () => setTimeout(() => {
                URL.revokeObjectURL(url);
                _blobUrls.splice(_blobUrls.indexOf(url), 1);
            }, 1000));
            entry.contentEl.appendChild(link);
            entry.barEl.style.width = '100%';
            entry.statusEl.textContent = 'Download ready';
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

    signaling.addEventListener('connected', () => {
        loginStatus('Joining room…');
        signaling.join(roomId, myName);
    });
    signaling.addEventListener('error',      (e) => loginStatus(e.detail.message || 'Server error', true));
    signaling.addEventListener('room-peers', () => {
        if (!joined) {
            joined = true;
            // Phase 4: create the Room broadcast conversation immediately on join
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
        // Phase 4: messages without a 'to' are group broadcasts → route to Room.
        // Previously `if (!partner) return` silently dropped all broadcasts.
        const isBroadcast = !msg.to;
        const convKey = isBroadcast
            ? ROOM_ID
            : (isMe ? msg.to : msg.from);

        ensureConv(convKey);
        const bubble = { sender: isMe ? 'me' : 'them', text: msg.text, time: fmt(msg.ts) };
        conversations[convKey].messages.push(bubble);

        if (activePeerId === convKey) appendBubble(bubble);
        else if (!isMe) conversations[convKey].unread++;
        renderPeerList();
    });
};

// L3: explicit teardown when the tab closes — ensures PC.close() / WS.close() fire
// even though browsers would clean them up anyway; also frees OS resources sooner.
window.addEventListener('beforeunload', () => {
    peerManager?.destroy();
    signaling?.destroy();
    // M3: revoke any remaining blob URLs
    _blobUrls.forEach(url => URL.revokeObjectURL(url));
    _blobUrls.length = 0;
});

// ── Show app ───────────────────────────────────────────────────────────────
function showApp() {
    document.getElementById('login-screen').classList.remove('active');
    document.getElementById('app-screen').classList.add('active');
    document.getElementById('display-my-name').textContent = myName;
    document.getElementById('display-room-id').textContent = roomId;
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

    // Separate Room entry from 1-on-1 peers
    const roomConv  = conversations[ROOM_ID];
    const peerIds   = Object.keys(conversations).filter(k => k !== ROOM_ID);

    if (!roomConv && peerIds.length === 0) { empty.style.display = ''; return; }
    empty.style.display = 'none';

    Array.from(list.children).forEach(c => { if (c !== empty) c.remove(); });

    // ── Room item (always first) ───────────────────────────────────────────
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

    // ── Individual peer items ──────────────────────────────────────────────
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
        st.textContent = onlineCount
            ? `${onlineCount} peer${onlineCount > 1 ? 's' : ''} connected`
            : 'No peers connected';
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
        _blobUrls.push(url); // M3: track for revocation
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

// ── Send message ───────────────────────────────────────────────────────────
window.sendMessage = function () {
    if (!activePeerId || !peerManager) return;

    const input = document.getElementById('msg-input');
    const text  = input.value.trim();

    input.value = '';
    input.focus();

    if (!text && !pendingFile) return;

    // ── Phase 4: Room broadcast path ──────────────────────────────────────
    if (activePeerId === ROOM_ID) {
        if (pendingFile) {
            sysMsg(ROOM_ID, 'To send a file, select a specific peer from the sidebar.');
            clearAttachment();
        }
        if (text) {
            const onlinePeers = peerManager.getPeerIds().filter(
                pid => peerManager.getChannel(pid, 'chat')?.readyState === 'open'
            );
            if (onlinePeers.length === 0) {
                sysMsg(ROOM_ID, 'No peers online — message not sent.');
                return;
            }
            chatManager.send(text); // emits 'message' event which routes to ROOM_ID
        }
        renderPeerList();
        return;
    }

    // ── 1-on-1 path ───────────────────────────────────────────────────────
    const conv = conversations[activePeerId];
    if (conv?.status !== 'online') {
        sysMsg(activePeerId, 'Peer is offline — message not sent.');
        return;
    }

    if (text) {
        const sent = peerManager.safeSend(activePeerId, 'chat', JSON.stringify({
            type: 'chat', id: crypto.randomUUID(),
            from: myName, to: activePeerId,
            text, ts: Date.now(),
        }));
        if (!sent) {
            sysMsg(activePeerId, 'Message not delivered — connection lost. Try again.');
            return;
        }
        const bubble = { sender: 'me', text, time: fmt(Date.now()) };
        conv.messages.push(bubble);
        appendBubble(bubble);
    }

    if (pendingFile) {
        const file = pendingFile;
        clearAttachment();

        const transferId = crypto.randomUUID();
        const entry = makeFileBubble('out', file.name, transferId);
        conv.messages.push({ _fileXfer: true, sender: 'me' });
        document.getElementById('messages-area').appendChild(entry.wrap);
        scrollEnd();

        fileManager.sendFile(activePeerId, file, transferId).catch((err) => {
            entry.statusEl.textContent = 'Send failed';
            log.error('[file] sendFile error:', err);
        });
    }

    renderPeerList();
};

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

// ── File handling ──────────────────────────────────────────────────────────
window.handleFileSelect = function (input) {
    if (!input.files?.[0]) return;
    pendingFile = input.files[0];
    document.getElementById('attach-name').textContent = pendingFile.name;
    document.getElementById('attach-bar').classList.add('visible');
};

window.clearAttachment = function () {
    pendingFile = null;
    document.getElementById('file-input').value = '';
    document.getElementById('attach-bar').classList.remove('visible');
};

// ── Helpers ────────────────────────────────────────────────────────────────
export function fmt(ts) {
    return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function scrollEnd() {
    const a = document.getElementById('messages-area');
    a.scrollTop = a.scrollHeight;
}

/**
 * Escape a string for safe insertion into HTML.
 * Escapes &, <, >, ", and ' to prevent XSS in both text content and
 * attribute values (both single- and double-quoted).
 */
export function esc(s) {
    if (!s) return '';
    return String(s)
        .replace(/&/g,  '&amp;')
        .replace(/</g,  '&lt;')
        .replace(/>/g,  '&gt;')
        .replace(/"/g,  '&quot;')
        .replace(/'/g,  '&#39;'); // L1: single-quote — required for single-quoted HTML attrs
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

// Pre-fill from URL query params
(function () {
    const p = new URLSearchParams(location.search);
    if (p.get('room')) document.getElementById('room-id').value = p.get('room');
    if (p.get('name')) document.getElementById('my-name').value = p.get('name');
})();
