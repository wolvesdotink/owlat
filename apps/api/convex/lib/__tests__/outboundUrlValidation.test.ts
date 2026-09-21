/**
 * Shape gate for server-fetched, caller-supplied URLs (AI-provider base URLs,
 * transactional-attachment URLs). Proves the security contract behind findings
 * M14 (provider key exfiltration) and M18 (attachment SSRF): non-http(s) schemes,
 * embedded credentials, and — under `requirePublic` — non-https or literal
 * private/internal hosts are all rejected BEFORE any fetch, while a keyless local
 * endpoint (Ollama on http://localhost) stays reachable.
 */

import { describe, it, expect } from 'vitest';
import { validateOutboundUrl } from '../outboundUrlValidation';

describe('validateOutboundUrl — shape rules (both modes)', () => {
	it('rejects an unparseable URL', () => {
		expect(validateOutboundUrl('not a url', { requirePublic: false })).toEqual({
			ok: false,
			error: 'must be a valid absolute URL',
		});
	});

	it('rejects a non-http(s) scheme', () => {
		for (const raw of ['file:///etc/passwd', 'gopher://x/', 'ftp://host/x']) {
			expect(validateOutboundUrl(raw, { requirePublic: false }).ok).toBe(false);
		}
	});

	it('rejects embedded credentials even in local mode', () => {
		expect(
			validateOutboundUrl('http://user:pass@localhost:11434/v1', { requirePublic: false })
		).toEqual({ ok: false, error: 'must not embed credentials' });
	});

	it('accepts a plain https URL', () => {
		const res = validateOutboundUrl('https://api.example.com/v1', { requirePublic: false });
		expect(res.ok).toBe(true);
	});
});

describe('validateOutboundUrl — requirePublic: false (local providers)', () => {
	it('allows http://localhost (a local Ollama endpoint)', () => {
		expect(validateOutboundUrl('http://localhost:11434/v1', { requirePublic: false }).ok).toBe(
			true
		);
	});

	it('allows a private-range host', () => {
		expect(validateOutboundUrl('http://192.168.1.10:11434/v1', { requirePublic: false }).ok).toBe(
			true
		);
	});
});

describe('validateOutboundUrl — requirePublic: true (hosted keys / attachments)', () => {
	it('rejects http (must upgrade to https)', () => {
		expect(validateOutboundUrl('http://api.example.com/v1', { requirePublic: true })).toEqual({
			ok: false,
			error: 'must use https',
		});
	});

	it('rejects the cloud metadata IP', () => {
		expect(
			validateOutboundUrl('https://169.254.169.254/latest/meta-data', { requirePublic: true })
		).toEqual({ ok: false, error: 'must not point at a private or internal address' });
	});

	it('rejects loopback (IPv4 and bracketed IPv6)', () => {
		expect(validateOutboundUrl('https://127.0.0.1/models', { requirePublic: true }).ok).toBe(false);
		expect(validateOutboundUrl('https://[::1]/models', { requirePublic: true }).ok).toBe(false);
	});

	it('rejects RFC1918 / link-local / CGNAT ranges', () => {
		for (const host of ['10.0.0.5', '172.16.9.9', '192.168.0.1', '169.254.10.10', '100.64.1.1']) {
			expect(validateOutboundUrl(`https://${host}/models`, { requirePublic: true }).ok).toBe(false);
		}
	});

	it('accepts a public https host and returns the parsed URL', () => {
		const res = validateOutboundUrl('https://openrouter.ai/api/v1', { requirePublic: true });
		expect(res.ok).toBe(true);
		if (res.ok) expect(res.url.hostname).toBe('openrouter.ai');
	});
});
