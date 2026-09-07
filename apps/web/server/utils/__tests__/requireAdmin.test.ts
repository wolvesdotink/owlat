/**
 * `requirePlatformAdmin`: authentication through the real `authedConvexClient`
 * (token proxy stubbed at the network), then the `isPlatformAdmin` probe on the
 * returned client.
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
