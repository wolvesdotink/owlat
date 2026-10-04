// @vitest-environment node
/**
 * The setup seed goes through Node's `fetch`, which Playwright does not trace,
 * so the instance secret it carries never reaches a trace in the public report
 * (#1203 review). Its errors name the status and body, never the secret.
 */
import { describe, expect, it, vi } from 'vitest';
import { seedAdmin } from '../seedAdmin';
import { testUser } from '../fixtures/test-data';

const SECRET = 'dummy-instance-secret-4f1c';

function respond(status: number, body = '{}') {
	return vi.fn<typeof fetch>().mockResolvedValue(new Response(body, { status }));
}

describe('seedAdmin', () => {
	it('posts the owner with the secret header through the given fetch', async () => {
		const fetchImpl = respond(201);

		await seedAdmin({
			siteUrl: 'https://site.example.invalid',
			instanceSecret: SECRET,
			owner: testUser(),
			fetchImpl,
		});

		expect(fetchImpl).toHaveBeenCalledOnce();
		const [url, init] = fetchImpl.mock.calls[0]!;
		expect(url).toBe('https://site.example.invalid/seed/admin');
		expect(init?.method).toBe('POST');
		expect(init?.headers).toMatchObject({ 'X-Instance-Secret': SECRET });
		const body = JSON.parse(String(init?.body)) as Record<string, string>;
		expect(body['email']).toBe(testUser().email);
		expect(body['passwordHash']).toBeTruthy();
		expect(body['passwordHash']).not.toBe(testUser().password);
	});

	it('accepts 409, an instance that is already bootstrapped', async () => {
		await expect(
			seedAdmin({
				siteUrl: 'https://site.example.invalid',
				instanceSecret: SECRET,
				owner: testUser(),
				fetchImpl: respond(409),
			})
		).resolves.toBeUndefined();
	});

	it('throws with the status and body, and without the secret', async () => {
		const failure = seedAdmin({
			siteUrl: 'https://site.example.invalid',
			instanceSecret: SECRET,
			owner: testUser(),
			fetchImpl: respond(403, '{"error":"forbidden"}'),
		});

		await expect(failure).rejects.toThrow(/returned 403: \{"error":"forbidden"\}/);
		await expect(failure).rejects.not.toThrow(SECRET);
	});

	it('throws without the host when the deployment cannot be reached (#1222)', async () => {
		// The cause names the host, and the error ends up in the public report,
		// whose scan deletes a report that names the deployment.
		const cause = Object.assign(new Error('getaddrinfo ENOTFOUND site.example.invalid'), {
			code: 'ENOTFOUND',
		});
		const failure = seedAdmin({
			siteUrl: 'https://site.example.invalid',
			instanceSecret: SECRET,
			owner: testUser(),
			fetchImpl: vi.fn<typeof fetch>().mockRejectedValue(new TypeError('fetch failed', { cause })),
		});

		await expect(failure).rejects.toThrow(
			'POST /seed/admin did not reach the deployment (ENOTFOUND).'
		);
		const error = (await failure.catch((caught: unknown) => caught)) as Error;
		expect(error.cause).toBeUndefined();
		expect(String(error.stack)).not.toContain('site.example.invalid');
	});
});
