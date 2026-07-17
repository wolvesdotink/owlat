import { describe, expect, it } from 'vitest';
import { nodeSyncHookTransport } from '../hookTransport';
import type { SyncHookTransportRequest } from '@owlat/plugin-host';

// Exercises the REAL SSRF guard (lib/ssrfGuard + lib/ipBlocklist) through the
// production transport. These are the transport's unique, security-critical
// responsibilities and need no reachable server: a disallowed destination is
// rejected before (or at) connect. The signed-round-trip wire mechanics are
// covered end to end in hookRoundTrip.integration.test.ts.

function request(url: string): SyncHookTransportRequest {
	return {
		url,
		headers: { 'x-owlat-hook-kind': 'gate' },
		body: JSON.stringify({ ping: true }),
		deadlineMs: 2_000,
		maxResponseBytes: 64 * 1_024,
	};
}

describe('nodeSyncHookTransport SSRF protection', () => {
	it('blocks a loopback destination', async () => {
		const outcome = await nodeSyncHookTransport(request('http://127.0.0.1:9/hook'));
		expect(outcome).toMatchObject({ ok: false, reason: 'blocked' });
	});

	it('blocks the cloud metadata link-local address', async () => {
		const outcome = await nodeSyncHookTransport(request('http://169.254.169.254/latest/meta-data'));
		expect(outcome).toMatchObject({ ok: false, reason: 'blocked' });
	});

	it('blocks a private RFC-1918 destination', async () => {
		const outcome = await nodeSyncHookTransport(request('http://10.0.0.5/hook'));
		expect(outcome).toMatchObject({ ok: false, reason: 'blocked' });
	});

	it('blocks a non-http(s) protocol', async () => {
		const outcome = await nodeSyncHookTransport(request('file:///etc/passwd'));
		expect(outcome).toMatchObject({ ok: false, reason: 'blocked' });
	});

	it('blocks a malformed URL', async () => {
		const outcome = await nodeSyncHookTransport(request('not a url'));
		expect(outcome).toMatchObject({ ok: false, reason: 'blocked' });
	});

	it('blocks a hostname that does not resolve', async () => {
		const outcome = await nodeSyncHookTransport(
			request('https://this-host-does-not-exist.owlat-hooks.invalid/hook')
		);
		expect(outcome).toMatchObject({ ok: false, reason: 'blocked' });
	});
});
