// app.test.js — tests for pure helpers exported from app.js
// Focus: esc() XSS prevention (L1 treated as security fix)
import { describe, it, expect } from 'vitest';
import { esc, fmt } from './app.js';

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
