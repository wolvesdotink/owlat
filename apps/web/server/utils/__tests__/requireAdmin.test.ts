/**
 * `requirePlatformAdmin`: authentication through the real `authedConvexClient`
 * (token proxy stubbed at the network), then the `isPlatformAdmin` probe on the
 * returned client. A failed probe goes through the shared `mapGateError`, so a
 * Convex outage answers 503 here exactly as it does on `requireOrgAdmin`.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ConvexHttpClient } from 'convex/browser';
import { getFunctionName } from 'convex/server';
import { api } from '@owlat/api';
import { requirePlatformAdmin } from '../requireAdmin';
import { installNitroGlobals, requestEvent } from './nitro';

const COOKIE = 'better-auth.session_token=abc123';
const fetchMock = vi.fn<typeof fetch>();
const query = vi.spyOn(ConvexHttpClient.prototype, 'query');

/** A Convex function error carrying the shared Operation error as its data. */
function operationFailure(category: string): Error {
	return Object.assign(new Error(category), { data: { category, message: category } });
}

beforeEach(() => {
	installNitroGlobals({
		convexUrl: 'https://convex.example.com',
		siteUrl: 'https://owlat.example',
	});
	fetchMock.mockReset().mockResolvedValue({
		ok: true,
		json: async () => ({ token: 'jwt-1' }),
	} as unknown as Response);
	vi.stubGlobal('fetch', fetchMock);
	query.mockReset();
});

describe('requirePlatformAdmin', () => {
	it('returns the authenticated client for a platform admin', async () => {
		query.mockResolvedValue(true);

		const client = await requirePlatformAdmin(requestEvent({ cookie: COOKIE }));

		expect(client).toBeInstanceOf(ConvexHttpClient);
		const [probe, args] = query.mock.calls[0]!;
		expect(getFunctionName(probe)).toBe(
			getFunctionName(api.platformAdmin.platformAdmin.isPlatformAdmin)
		);
		expect(args).toEqual({});
	});

	it('answers 403 for a signed-in member who is not a platform admin', async () => {
		query.mockResolvedValue(false);

		await expect(requirePlatformAdmin(requestEvent({ cookie: COOKIE }))).rejects.toMatchObject({
			statusCode: 403,
			message: 'Platform admin access required',
		});
	});

	it('answers 503, not an unmapped 500, when Convex is unreachable', async () => {
		query.mockRejectedValue(new TypeError('fetch failed'));

		await expect(requirePlatformAdmin(requestEvent({ cookie: COOKIE }))).rejects.toMatchObject({
			statusCode: 503,
			message: 'Could not verify access: the backend is unreachable.',
		});
	});

	it('answers 401 when the probe reports the session as unauthenticated', async () => {
		query.mockRejectedValue(operationFailure('unauthenticated'));

		await expect(requirePlatformAdmin(requestEvent({ cookie: COOKIE }))).rejects.toMatchObject({
			statusCode: 401,
		});
	});

	it('answers 403 when the probe itself denies access', async () => {
		query.mockRejectedValue(operationFailure('forbidden'));

		await expect(requirePlatformAdmin(requestEvent({ cookie: COOKIE }))).rejects.toMatchObject({
			statusCode: 403,
			message: 'Platform admin access required',
		});
	});

	it('answers 401 for an unauthenticated call and never runs the probe', async () => {
		await expect(requirePlatformAdmin(requestEvent())).rejects.toMatchObject({ statusCode: 401 });
		expect(query).not.toHaveBeenCalled();
	});

	it('answers 401 when the session cookie no longer exchanges for a token', async () => {
		fetchMock.mockResolvedValue({ ok: false, json: async () => ({}) } as unknown as Response);

		await expect(requirePlatformAdmin(requestEvent({ cookie: COOKIE }))).rejects.toMatchObject({
			statusCode: 401,
		});
		expect(query).not.toHaveBeenCalled();
	});
});
