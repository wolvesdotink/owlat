import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/**
 * Startup-warning behavior for `getClientIp`'s trusted-proxy modes (M2).
 *
 * `xforwarded` is the documented safe default: it reads the proxy-appended entry
 * from the right and is bypass-resistant on its own, so it warns about nothing.
 * `cloudflare` and `xrealip` trust a client-settable header UNCONDITIONALLY —
 * safe only behind infra-level origin fencing the code cannot verify — so
 * selecting either must emit a hard, once-per-instance warning pointing at the
 * trap.
 *
 * The warning latch is module-level, so each case re-imports the module fresh
 * via `vi.resetModules()` to assert independently.
 */

vi.mock('../lib/runtimeLog', async (importOriginal) => {
	const actual = await importOriginal<typeof import('../lib/runtimeLog')>();
	return { ...actual, logWarn: vi.fn() };
});

function req(headers: Record<string, string>): Request {
	return new Request('https://deployment.convex.site/forms/abc', { headers });
}

async function freshModule(): Promise<{
	getClientIp: (r: Request) => string;
	logWarn: ReturnType<typeof vi.fn>;
}> {
	vi.resetModules();
	const runtimeLog = await import('../lib/runtimeLog');
	const mod = await import('../publicRateLimit');
	return { getClientIp: mod.getClientIp, logWarn: runtimeLog.logWarn as ReturnType<typeof vi.fn> };
}

beforeEach(() => {
	// The mocked logWarn persists across resetModules, so clear its call history
	// per test; the module-level warn latch itself is reset by freshModule().
	vi.clearAllMocks();
});

afterEach(() => {
	vi.unstubAllEnvs();
});

describe('getClientIp trusted-proxy warnings (M2)', () => {
	it('warns (once) that cloudflare mode trusts a spoofable header', async () => {
		vi.stubEnv('RATE_LIMIT_TRUSTED_PROXY', 'cloudflare');
		vi.stubEnv('RATE_LIMIT_PROXY_SECRET', 'proxy-shared-secret');
		const { getClientIp, logWarn } = await freshModule();

		const authed = (ip: string) =>
			req({ 'CF-Connecting-IP': ip, 'X-Owlat-Proxy-Secret': 'proxy-shared-secret' });
		expect(getClientIp(authed('203.0.113.1'))).toBe('203.0.113.1');
		expect(getClientIp(authed('203.0.113.2'))).toBe('203.0.113.2');

		expect(logWarn).toHaveBeenCalledTimes(1);
		expect(String(logWarn.mock.calls[0]?.[0])).toContain('CF-Connecting-IP');
	});

	it('warns even when the mode fails closed for lack of a proxy secret', async () => {
		// The advisory fires on mode SELECTION, independent of whether any given
		// request presents the secret — so a deployment that selected cloudflare
		// without RATE_LIMIT_PROXY_SECRET is still told about the trap.
		vi.stubEnv('RATE_LIMIT_TRUSTED_PROXY', 'cloudflare');
		const { getClientIp, logWarn } = await freshModule();

		expect(getClientIp(req({ 'CF-Connecting-IP': '203.0.113.1' }))).toBe('unknown');

		expect(logWarn).toHaveBeenCalledTimes(1);
		expect(String(logWarn.mock.calls[0]?.[0])).toContain('RATE_LIMIT_PROXY_SECRET');
	});

	it('warns that xrealip mode trusts a spoofable header', async () => {
		vi.stubEnv('RATE_LIMIT_TRUSTED_PROXY', 'xrealip');
		vi.stubEnv('RATE_LIMIT_PROXY_SECRET', 'proxy-shared-secret');
		const { getClientIp, logWarn } = await freshModule();

		expect(
			getClientIp(
				req({ 'X-Real-IP': '198.51.100.9', 'X-Owlat-Proxy-Secret': 'proxy-shared-secret' })
			)
		).toBe('198.51.100.9');

		expect(logWarn).toHaveBeenCalledTimes(1);
		expect(String(logWarn.mock.calls[0]?.[0])).toContain('X-Real-IP');
	});

	it('does NOT warn for the bypass-resistant xforwarded default', async () => {
		vi.stubEnv('RATE_LIMIT_TRUSTED_PROXY', 'xforwarded');
		const { getClientIp, logWarn } = await freshModule();

		expect(getClientIp(req({ 'X-Forwarded-For': '1.1.1.1, 203.0.113.9' }))).toBe('203.0.113.9');

		expect(logWarn).not.toHaveBeenCalled();
	});
});
