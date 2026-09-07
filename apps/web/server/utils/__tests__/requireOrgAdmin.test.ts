/**
 * `requireOrgAdmin`: authentication through the real `authedConvexClient`
 * (token proxy stubbed at the network), then the admin-gated
 * `delivery.status.getStatus` probe whose clean return is the
 * `organization:manage` proof. Only an Operation error of category
 * `forbidden` / `unauthenticated` is an access answer; anything else is the
 * backend being unreachable.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ConvexHttpClient } from 'convex/browser';
import { getFunctionName } from 'convex/server';
import { api } from '@owlat/api';
import { requireOrgAdmin } from '../requireOrgAdmin';
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

describe('requireOrgAdmin', () => {
	it('returns the authenticated client once the status probe passes', async () => {
		query.mockResolvedValue({ hasProvider: true });

		const client = await requireOrgAdmin(requestEvent({ cookie: COOKIE }));

		expect(client).toBeInstanceOf(ConvexHttpClient);
		const [probe, args] = query.mock.calls[0]!;
		expect(getFunctionName(probe)).toBe(getFunctionName(api.delivery.status.getStatus));
		expect(args).toEqual({});
	});

	it('answers 403 when the probe denies the member the admin floor', async () => {
		query.mockRejectedValue(operationFailure('forbidden'));

		await expect(requireOrgAdmin(requestEvent({ cookie: COOKIE }))).rejects.toMatchObject({
			statusCode: 403,
			message: 'Delivery admin access required',
		});
	});

	it('answers 401 when the probe reports the session as unauthenticated', async () => {
		query.mockRejectedValue(operationFailure('unauthenticated'));

		await expect(requireOrgAdmin(requestEvent({ cookie: COOKIE }))).rejects.toMatchObject({
			statusCode: 401,
		});
	});

	it('answers 503, not an access denial, when the probe fails for any other reason', async () => {
		query.mockRejectedValue(new Error('fetch failed'));

		await expect(requireOrgAdmin(requestEvent({ cookie: COOKIE }))).rejects.toMatchObject({
			statusCode: 503,
		});
	});

	it('answers 401 for an unauthenticated call and never runs the probe', async () => {
		await expect(requireOrgAdmin(requestEvent())).rejects.toMatchObject({ statusCode: 401 });
		expect(query).not.toHaveBeenCalled();
	});
});
