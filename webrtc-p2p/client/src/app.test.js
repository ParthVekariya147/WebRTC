// app.test.js — tests for pure helpers exported from app.js
// Focus: esc() XSS prevention (L1 treated as security fix)
import { describe, it, expect } from 'vitest';
import { esc, fmt, fileCategory, fmtSize, fileSidebarLabel, buildFileMessage } from './app.js';

// ── esc() — XSS prevention ─────────────────────────────────────────────────

describe('esc() — HTML escaping / XSS prevention', () => {

    it('returns empty string for falsy inputs', () => {
        expect(esc('')).toBe('');
        expect(esc(null)).toBe('');
        expect(esc(undefined)).toBe('');
        expect(esc(0)).toBe('');
    });

    it('escapes & to &amp;', () => {
        expect(esc('a & b')).toBe('a &amp; b');
    });

    it('escapes < to &lt; — blocks tag injection', () => {
        expect(esc('<script>')).toBe('&lt;script&gt;');
        expect(esc('<img src=x>')).toBe('&lt;img src=x&gt;');
    });

    it('escapes > to &gt;', () => {
        expect(esc('1 > 0')).toBe('1 &gt; 0');
    });

    it('escapes " to &quot; — safe in double-quoted attributes', () => {
        expect(esc('"hello"')).toBe('&quot;hello&quot;');
    });

    it('escapes \' to &#39; — safe in single-quoted attributes (L1 fix)', () => {
        // Before the L1 fix, single quotes were NOT escaped.
        // A crafted peer name like: '  onmouseover='alert(1)
        // in a single-quoted attribute: attr='${esc(name)}' would execute JS.
        expect(esc("it's")).toBe('it&#39;s');
        expect(esc("' onmouseover='alert(1)")).toBe('&#39; onmouseover=&#39;alert(1)');
    });

    // ── The critical XSS payloads ──────────────────────────────────────────

    it('neutralises a classic script injection payload', () => {
        const payload = '<script>alert("XSS")</script>';
        const result = esc(payload);
        expect(result).not.toContain('<script>');
        expect(result).not.toContain('</script>');
        expect(result).toBe('&lt;script&gt;alert(&quot;XSS&quot;)&lt;/script&gt;');
    });

    it('neutralises an img onerror payload', () => {
        const payload = '<img src=x onerror=alert(1)>';
        const result = esc(payload);
        // The tag delimiters are what make onerror dangerous — they must be escaped.
        // The text "onerror" is harmless once < and > are neutralised.
        expect(result).not.toMatch(/<img/i);      // no raw opening tag
        expect(result).toContain('&lt;img');       // angle bracket is escaped
        expect(result).toContain('&gt;');          // closing bracket is escaped
    });

    it('neutralises an attribute break-out with double quotes', () => {
        // Attacker sets their name to: "  onclick="alert(1)
        // If placed in: <div class="${esc(name)}"> without escaping this would inject onclick.
        const payload = '" onclick="alert(1)';
        const result = esc(payload);
        expect(result).not.toContain('"');
        expect(result).toBe('&quot; onclick=&quot;alert(1)');
    });

    it('neutralises an attribute break-out with single quotes', () => {
        const payload = "' onclick='alert(1)";
        const result = esc(payload);
        expect(result).not.toContain("'");
        expect(result).toBe('&#39; onclick=&#39;alert(1)');
    });

    it('neutralises a javascript: protocol injected via HTML tag', () => {
        // esc() is for text/attribute values, not URLs directly.
        // When a peer name contains a full <a href=javascript:> tag, esc() neutralises
        // it by escaping the angle brackets — the "javascript:" text is inert without
        // a live href attribute context.
        const payload = '<a href="javascript:alert(1)">click</a>';
        const result = esc(payload);
        expect(result).not.toMatch(/<a\s/i);       // no raw <a tag
        expect(result).toContain('&lt;a');          // angle bracket escaped
    });

    it('handles strings with multiple attack vectors simultaneously', () => {
        const payload = `"><script>alert('xss')</script><img src=x onerror=alert(1)>`;
        const result = esc(payload);
        expect(result).not.toMatch(/<[a-zA-Z]/);   // no unescaped HTML tags
        expect(result).not.toContain('"');          // no unescaped double quotes
        expect(result).not.toContain("'");          // no unescaped single quotes
    });

    it('does not double-escape already-escaped content', () => {
        // esc() is not idempotent by design — it escapes raw strings, not HTML.
        // This test documents the expected behaviour so future changes don't surprise.
        const alreadyEscaped = '&lt;b&gt;bold&lt;/b&gt;';
        const result = esc(alreadyEscaped);
        // The & in &lt; gets escaped to &amp;lt; — this is correct for raw strings
        expect(result).toContain('&amp;lt;');
    });

    it('coerces non-string inputs to string before escaping', () => {
        expect(esc(42)).toBe('42');
        expect(esc(true)).toBe('true');
    });
});

// ── fileCategory() ─────────────────────────────────────────────────────────

describe('fileCategory() — file type detection', () => {
    it('detects image types', () => {
        expect(fileCategory('image/png')).toBe('image');
        expect(fileCategory('image/jpeg')).toBe('image');
        expect(fileCategory('image/gif')).toBe('image');
        expect(fileCategory('image/webp')).toBe('image');
    });

    it('detects video types', () => {
        expect(fileCategory('video/mp4')).toBe('video');
        expect(fileCategory('video/webm')).toBe('video');
        expect(fileCategory('video/quicktime')).toBe('video');
    });

    it('detects audio types', () => {
        expect(fileCategory('audio/mpeg')).toBe('audio');
        expect(fileCategory('audio/wav')).toBe('audio');
    });

    it('detects PDF by mime type', () => {
        expect(fileCategory('application/pdf')).toBe('pdf');
    });

    it('detects PDF by filename extension when mime is generic', () => {
        expect(fileCategory('application/octet-stream', 'report.pdf')).toBe('pdf');
        expect(fileCategory('', 'document.PDF')).toBe('pdf');
    });

    it('returns other for unknown types', () => {
        expect(fileCategory('application/zip')).toBe('other');
        expect(fileCategory('text/plain')).toBe('other');
        expect(fileCategory('', 'archive.zip')).toBe('other');
    });

    it('returns other for empty inputs', () => {
        expect(fileCategory()).toBe('other');
        expect(fileCategory('', '')).toBe('other');
    });
});

// ── fmtSize() ──────────────────────────────────────────────────────────────

describe('fmtSize() — byte size formatting', () => {
    it('formats bytes', () => {
        expect(fmtSize(0)).toBe('0 B');
        expect(fmtSize(512)).toBe('512 B');
        expect(fmtSize(1023)).toBe('1023 B');
    });

    it('formats kilobytes', () => {
        expect(fmtSize(1024)).toBe('1.0 KB');
        expect(fmtSize(1536)).toBe('1.5 KB');
        expect(fmtSize(1024 * 999)).toBe('999.0 KB');
    });

    it('formats megabytes', () => {
        expect(fmtSize(1024 * 1024)).toBe('1.0 MB');
        expect(fmtSize(1024 * 1024 * 50)).toBe('50.0 MB');
        expect(fmtSize(1024 * 1024 * 100)).toBe('100.0 MB');
    });

    it('formats gigabytes', () => {
        expect(fmtSize(1024 * 1024 * 1024)).toBe('1.00 GB');
        expect(fmtSize(1024 * 1024 * 1024 * 2.5)).toBe('2.50 GB');
    });
});

// ── fileSidebarLabel() ─────────────────────────────────────────────────────

describe('fileSidebarLabel() — sidebar file preview label', () => {
    it('shows photo icon for images', () => {
        expect(fileSidebarLabel({ mimeType: 'image/jpeg', fileName: 'photo.jpg' })).toBe('📷 photo.jpg');
        expect(fileSidebarLabel({ mimeType: 'image/png',  fileName: 'pic.png'   })).toBe('📷 pic.png');
    });

    it('shows video icon for videos', () => {
        expect(fileSidebarLabel({ mimeType: 'video/mp4',  fileName: 'clip.mp4'  })).toBe('🎥 clip.mp4');
        expect(fileSidebarLabel({ mimeType: 'video/webm', fileName: 'film.webm' })).toBe('🎥 film.webm');
    });

    it('shows audio icon for audio', () => {
        expect(fileSidebarLabel({ mimeType: 'audio/mpeg', fileName: 'song.mp3' })).toBe('🎵 song.mp3');
        expect(fileSidebarLabel({ mimeType: 'audio/wav',  fileName: 'beat.wav' })).toBe('🎵 beat.wav');
    });

    it('shows document icon for PDFs', () => {
        expect(fileSidebarLabel({ mimeType: 'application/pdf', fileName: 'doc.pdf' })).toBe('📄 doc.pdf');
    });

    it('shows attachment icon for other file types', () => {
        expect(fileSidebarLabel({ mimeType: 'application/zip', fileName: 'archive.zip' })).toBe('📎 archive.zip');
        expect(fileSidebarLabel({ mimeType: 'text/plain',       fileName: 'notes.txt'  })).toBe('📎 notes.txt');
    });

    it('never returns a string containing "undefined"', () => {
        expect(fileSidebarLabel({ mimeType: null,      fileName: null      })).not.toContain('undefined');
        expect(fileSidebarLabel({ mimeType: undefined, fileName: undefined })).not.toContain('undefined');
        expect(fileSidebarLabel({})).not.toContain('undefined');
    });

    it('falls back to "File" when fileName is null or missing', () => {
        expect(fileSidebarLabel({ mimeType: 'image/png', fileName: null      })).toBe('📷 File');
        expect(fileSidebarLabel({ mimeType: 'image/png'                      })).toBe('📷 File');
        expect(fileSidebarLabel({ mimeType: 'application/zip', fileName: null})).toBe('📎 File');
    });

    it('detects PDF by filename extension when mimeType is generic', () => {
        expect(fileSidebarLabel({ mimeType: 'application/octet-stream', fileName: 'report.pdf' })).toBe('📄 report.pdf');
    });
});

// ── fmt() ──────────────────────────────────────────────────────────────────

describe('fmt() — timestamp formatting', () => {
    it('returns a string for a valid timestamp', () => {
        const result = fmt(Date.now());
        expect(typeof result).toBe('string');
        expect(result.length).toBeGreaterThan(0);
    });

    it('formats as HH:MM', () => {
        // Use a fixed timestamp: 2024-01-15 14:30:00 UTC
        const ts = new Date('2024-01-15T14:30:00').getTime();
        const result = fmt(ts);
        // Should contain digits and a colon — exact value depends on locale
        expect(result).toMatch(/\d{1,2}:\d{2}/);
    });
});

// ── buildFileMessage() — canonical schema ─────────────────────────────────

describe('buildFileMessage() — canonical file message schema', () => {
    const base = {
        sender: 'me',
        fileName: 'photo.jpg',
        fileSize: 12345,
        mimeType: 'image/jpeg',
        fileId: 'test-uuid-1234',
        blobUrl: 'blob:http://localhost/abc',
    };

    it('sets type to "file"', () => {
        expect(buildFileMessage(base).type).toBe('file');
    });

    it('carries fileName — never undefined', () => {
        const msg = buildFileMessage(base);
        expect(msg.fileName).toBeDefined();
        expect(msg.fileName).toBe('photo.jpg');
    });

    it('carries fileSize, mimeType, fileId', () => {
        const msg = buildFileMessage(base);
        expect(msg.fileSize).toBe(12345);
        expect(msg.mimeType).toBe('image/jpeg');
        expect(msg.fileId).toBe('test-uuid-1234');
    });

    it('defaults blobUrl to null when omitted', () => {
        const msg = buildFileMessage({ ...base, blobUrl: undefined });
        expect(msg.blobUrl).toBeNull();
    });

    it('preserves blobUrl when provided', () => {
        const msg = buildFileMessage(base);
        expect(msg.blobUrl).toBe('blob:http://localhost/abc');
    });

    it('receiver fileName matches sender fileName — no field drift', () => {
        const senderMsg = buildFileMessage({ ...base, sender: 'me' });
        const receiverMsg = buildFileMessage({
            sender: 'them',
            fileName: base.fileName,   // comes from transfer-start detail.name
            fileSize: base.fileSize,
            mimeType: base.mimeType,
            fileId: base.fileId,
        });
        expect(receiverMsg.fileName).toBeDefined();
        expect(receiverMsg.fileName).toBe(senderMsg.fileName);
    });

    it('includes a time string', () => {
        const msg = buildFileMessage(base);
        expect(typeof msg.time).toBe('string');
        expect(msg.time).toMatch(/\d{1,2}:\d{2}/);
    });
});
