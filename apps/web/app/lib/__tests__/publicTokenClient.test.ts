import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PUBLIC_TOKEN_REASONS, fetchPublicToken, readPublicTokenBody } from '../publicTokenClient';

const shareData = {
	html: '<p>hi</p>',
	subject: 'Spring sale',
	organizationName: 'Acme',
	expiresAt: 1_900_000_000_000,
};

function answer(status: number, body: unknown) {
	return {
		ok: status >= 200 && status < 300,
		status,
		json: async () => {
			if (body instanceof Error) throw body;
			return body;
		},
	};
}

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
	fetchMock = vi.fn();
	vi.stubGlobal('fetch', fetchMock);
	vi.stubGlobal('useRuntimeConfig', () => ({
		public: { convexSiteUrl: 'https://owlat.convex.site' },
	}));
});

afterEach(() => {
	vi.unstubAllGlobals();
});

describe('fetchPublicToken', () => {
	it('builds <site>/<path>/<token> with the token URL-encoded and passes init through', async () => {
		fetchMock.mockResolvedValue(answer(200, { ok: true, data: { alreadyUnsubscribed: false } }));
		const init = { method: 'POST' };

		await fetchPublicToken('unsub', 'abc:123/sig', init);

		expect(fetchMock).toHaveBeenCalledWith('https://owlat.convex.site/unsub/abc%3A123%2Fsig', init);
	});

	it('returns the data of a { ok: true, data } answer', async () => {
		fetchMock.mockResolvedValue(answer(200, { ok: true, data: shareData }));
		expect(await fetchPublicToken('share', 'tok')).toEqual({ ok: true, data: shareData });
	});

	it('reads the reason of an outcome-mode answer (200 with { ok: false, reason })', async () => {
		fetchMock.mockResolvedValue(answer(200, { ok: false, reason: 'expired' }));
		expect(await fetchPublicToken('unsub/verify', 'tok')).toEqual({
			ok: false,
			reason: 'expired',
		});
	});

	it('reads the reason out of the action-mode error envelope, not the English message', async () => {
		// The share endpoint answers an expired link with 404 (the taxonomy has
		// no Gone); "expired" rides in error.data.reason.
		fetchMock.mockResolvedValue(
			answer(404, {
				error: {
					category: 'not_found',
					message: 'This share link has expired',
					data: { reason: 'expired' },
				},
			})
		);
		expect(await fetchPublicToken('share', 'tok')).toEqual({ ok: false, reason: 'expired' });
	});

	it('does not trust { ok: true } on a non-2xx answer', async () => {
		fetchMock.mockResolvedValue(answer(500, { ok: true, data: shareData }));
		expect(await fetchPublicToken('share', 'tok')).toEqual({
			ok: false,
			reason: PUBLIC_TOKEN_REASONS.badResponse,
		});
	});

	it('maps a body that is not JSON to bad_response', async () => {
		fetchMock.mockResolvedValue(answer(502, new SyntaxError('Unexpected token <')));
		expect(await fetchPublicToken('archive', 'tok')).toEqual({
			ok: false,
			reason: PUBLIC_TOKEN_REASONS.badResponse,
		});
	});

	it('maps a network failure to network_error instead of throwing', async () => {
		fetchMock.mockRejectedValue(new TypeError('Failed to fetch'));
		expect(await fetchPublicToken('archive', 'tok')).toEqual({
			ok: false,
			reason: PUBLIC_TOKEN_REASONS.network,
		});
	});

	it('maps the rate limiter answer (429, no reason) to rate_limited', async () => {
		fetchMock.mockResolvedValue(
			answer(429, {
				error: {
					category: 'rate_limited',
					message: 'Rate limit exceeded. Please try again later.',
				},
			})
		);
		expect(await fetchPublicToken('unsub', 'tok', { method: 'POST' })).toEqual({
			ok: false,
			reason: PUBLIC_TOKEN_REASONS.rateLimited,
		});
	});
});

describe('readPublicTokenBody', () => {
	it('treats a 2xx without data as a bad response', () => {
		expect(readPublicTokenBody(true, 200, { ok: true })).toEqual({
			ok: false,
			reason: PUBLIC_TOKEN_REASONS.badResponse,
		});
		expect(readPublicTokenBody(true, 200, null)).toEqual({
			ok: false,
			reason: PUBLIC_TOKEN_REASONS.badResponse,
		});
	});

	it('reads the rate-limit category without the 429 status', () => {
		expect(readPublicTokenBody(false, 400, { error: { category: 'rate_limited' } })).toEqual({
			ok: false,
			reason: PUBLIC_TOKEN_REASONS.rateLimited,
		});
	});

	it('ignores a reason that is not a string', () => {
		expect(readPublicTokenBody(false, 404, { error: { data: { reason: 7 } } })).toEqual({
			ok: false,
			reason: PUBLIC_TOKEN_REASONS.badResponse,
		});
	});
});
