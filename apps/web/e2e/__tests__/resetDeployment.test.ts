// @vitest-environment node
/**
 * The workflow resets the test deployment when a run ends, so the seeded
 * owner's sessions stop authenticating (#1222). The call goes through Node's
 * `fetch`, and its errors name neither the secret nor the deployment.
 */
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { resetDeployment } from '../resetDeployment';

const SECRET = 'dummy-instance-secret-4f1c';
const SITE = 'https://dummy-site-7c1e.example.invalid';
const CLI = resolve(__dirname, '../reset-deployment.ts');

function respond(status: number, body: string) {
	return vi.fn<typeof fetch>().mockResolvedValue(new Response(body, { status }));
}

describe('resetDeployment', () => {
	it('posts to /dev/reset with the secret header and returns what was deleted', async () => {
		const fetchImpl = respond(200, JSON.stringify({ deleted: { sessions: 2, users: 1 } }));

		const result = await resetDeployment({ siteUrl: SITE, instanceSecret: SECRET, fetchImpl });

		expect(result).toEqual({ deleted: { sessions: 2, users: 1 } });
		expect(fetchImpl).toHaveBeenCalledOnce();
		const [url, init] = fetchImpl.mock.calls[0]!;
		expect(url).toBe(`${SITE}/dev/reset`);
		expect(init?.method).toBe('POST');
		expect(init?.headers).toEqual({ 'X-Instance-Secret': SECRET });
		expect(init?.signal).toBeInstanceOf(AbortSignal);
	});

	it.each([
		[401, '{"error":"unauthorized"}'],
		[500, '{"error":{"category":"internal"}}'],
	])('fails on HTTP %i, naming the status and body but not the secret', async (status, body) => {
		const fetchImpl = respond(status, body);

		const failure = resetDeployment({ siteUrl: SITE, instanceSecret: SECRET, fetchImpl });
		await expect(failure).rejects.toThrow(`HTTP ${status}: ${body}`);
		await expect(failure).rejects.not.toThrow(SECRET);
	});

	it.each([
		['a body that is not JSON', 'ok'],
		['no deleted counts', '{"ok":true}'],
	])('fails on a 200 with %s, which is not a reset that ran', async (_what, body) => {
		const fetchImpl = respond(200, body);

		await expect(
			resetDeployment({ siteUrl: SITE, instanceSecret: SECRET, fetchImpl })
		).rejects.toThrow('POST /dev/reset answered 200');
	});

	it('fails on a network error without naming the deployment', async () => {
		const cause = Object.assign(
			new Error('getaddrinfo ENOTFOUND dummy-site-7c1e.example.invalid'),
			{
				code: 'ENOTFOUND',
			}
		);
		const fetchImpl = vi
			.fn<typeof fetch>()
			.mockRejectedValue(new TypeError('fetch failed', { cause }));

		const failure = resetDeployment({ siteUrl: SITE, instanceSecret: SECRET, fetchImpl });
		await expect(failure).rejects.toThrow('did not reach the deployment (ENOTFOUND)');
		await expect(failure).rejects.not.toThrow('example.invalid');
	});
});

describe('reset-deployment CLI', () => {
	it.each([[{ CONVEX_TEST_SITE_URL: SITE }], [{ CONVEX_TEST_INSTANCE_SECRET: SECRET }]])(
		'fails before any request when a variable is missing',
		(env) => {
			const result = spawnSync('bun', [CLI], {
				env: {
					PATH: process.env['PATH'],
					CONVEX_TEST_SITE_URL: '',
					CONVEX_TEST_INSTANCE_SECRET: '',
					...env,
				},
				encoding: 'utf8',
			});
			expect(result.status).toBe(1);
			expect(result.stderr).toContain('must both be set');
		}
	);

	it('fails, naming no host, when the deployment cannot be reached', () => {
		const result = spawnSync('bun', [CLI], {
			env: {
				PATH: process.env['PATH'],
				// Port 9 (discard) on loopback: refused at once, no network needed.
				CONVEX_TEST_SITE_URL: 'http://127.0.0.1:9',
				CONVEX_TEST_INSTANCE_SECRET: SECRET,
			},
			encoding: 'utf8',
		});
		expect(result.status).toBe(1);
		expect(result.stderr).toContain('POST /dev/reset did not reach the deployment');
		expect(result.stderr).not.toContain('127.0.0.1');
		expect(result.stderr).not.toContain(SECRET);
	});
});
