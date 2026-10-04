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
});
