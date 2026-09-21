import { describe, it, expect, vi, afterEach } from 'vitest';
import { getClientIp } from '../publicRateLimit';

/**
 * getClientIp must not let a client-supplied forwarded header mint unlimited
 * rate-limit buckets. Headers are trusted only per RATE_LIMIT_TRUSTED_PROXY,
 * and X-Forwarded-For is read from the RIGHT (the trusted-proxy-appended entry),
 * never the leftmost attacker-controlled one.
 */
function req(headers: Record<string, string>): Request {
	return new Request('https://deployment.convex.site/forms/abc', { headers });
}

afterEach(() => {
	vi.unstubAllEnvs();
});

describe('getClientIp', () => {
	it('returns a shared bucket and ignores spoofed headers when unconfigured', () => {
		expect(getClientIp(req({ 'X-Forwarded-For': '1.2.3.4', 'CF-Connecting-IP': '5.6.7.8' }))).toBe(
			'unknown'
		);
	});

	it('cloudflare mode trusts CF-Connecting-IP only when the proxy secret authenticates the request', () => {
		vi.stubEnv('RATE_LIMIT_TRUSTED_PROXY', 'cloudflare');
		vi.stubEnv('RATE_LIMIT_PROXY_SECRET', 'proxy-shared-secret');
		expect(
			getClientIp(
				req({
					'CF-Connecting-IP': '203.0.113.7',
					'X-Forwarded-For': 'evil',
					'X-Owlat-Proxy-Secret': 'proxy-shared-secret',
				})
			)
		).toBe('203.0.113.7');
		// Correct secret, but the trusted header is absent → shared bucket.
		expect(
			getClientIp(req({ 'X-Forwarded-For': 'evil', 'X-Owlat-Proxy-Secret': 'proxy-shared-secret' }))
		).toBe('unknown');
	});

	it('cloudflare mode FAILS CLOSED to unknown when the proxy secret is missing/wrong/unset (M2)', () => {
		vi.stubEnv('RATE_LIMIT_TRUSTED_PROXY', 'cloudflare');
		// Attacker hits *.convex.site directly and forges CF-Connecting-IP. Without
		// RATE_LIMIT_PROXY_SECRET configured, the forged header must NOT mint a fresh
		// per-IP bucket — every such caller collapses to the shared 'unknown' bucket.
		expect(getClientIp(req({ 'CF-Connecting-IP': '203.0.113.1' }))).toBe('unknown');
		expect(getClientIp(req({ 'CF-Connecting-IP': '203.0.113.2' }))).toBe('unknown');

		// Secret configured on the server, but the forger cannot present it (absent
		// or wrong) → still the shared bucket, so no per-request bypass.
		vi.stubEnv('RATE_LIMIT_PROXY_SECRET', 'proxy-shared-secret');
		expect(getClientIp(req({ 'CF-Connecting-IP': '203.0.113.3' }))).toBe('unknown');
		expect(
			getClientIp(
				req({ 'CF-Connecting-IP': '203.0.113.4', 'X-Owlat-Proxy-Secret': 'not-the-secret' })
			)
		).toBe('unknown');
	});

	it('xforwarded mode reads the rightmost (proxy-appended) entry, ignoring spoofed leftmost', () => {
		vi.stubEnv('RATE_LIMIT_TRUSTED_PROXY', 'xforwarded');
		// Attacker injects "1.1.1.1"; the trusted proxy appends the real client last.
		expect(getClientIp(req({ 'X-Forwarded-For': '1.1.1.1, 9.9.9.9, 203.0.113.50' }))).toBe(
			'203.0.113.50'
		);
	});

	it('xforwarded:<hops> reads N entries from the right', () => {
		vi.stubEnv('RATE_LIMIT_TRUSTED_PROXY', 'xforwarded:2');
		// Two trusted proxies: real client is 2 from the right.
		expect(getClientIp(req({ 'X-Forwarded-For': 'evil, 203.0.113.50, 10.0.0.1' }))).toBe(
			'203.0.113.50'
		);
	});

	it('xrealip mode trusts X-Real-IP only with the correct proxy secret', () => {
		vi.stubEnv('RATE_LIMIT_TRUSTED_PROXY', 'xrealip');
		vi.stubEnv('RATE_LIMIT_PROXY_SECRET', 'proxy-shared-secret');
		expect(
			getClientIp(
				req({
					'X-Real-IP': '198.51.100.9',
					'X-Forwarded-For': 'evil',
					'X-Owlat-Proxy-Secret': 'proxy-shared-secret',
				})
			)
		).toBe('198.51.100.9');
	});

	it('xrealip mode FAILS CLOSED to unknown when the proxy secret is absent or wrong (M2)', () => {
		vi.stubEnv('RATE_LIMIT_TRUSTED_PROXY', 'xrealip');
		vi.stubEnv('RATE_LIMIT_PROXY_SECRET', 'proxy-shared-secret');
		expect(getClientIp(req({ 'X-Real-IP': '198.51.100.9' }))).toBe('unknown');
		expect(getClientIp(req({ 'X-Real-IP': '198.51.100.9', 'X-Owlat-Proxy-Secret': 'wrong' }))).toBe(
			'unknown'
		);
	});

	it('falls back to unknown when the configured header is absent', () => {
		vi.stubEnv('RATE_LIMIT_TRUSTED_PROXY', 'xforwarded');
		expect(getClientIp(req({}))).toBe('unknown');
	});
});
