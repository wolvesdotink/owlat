/**
 * A DROPPED REQUEST IS NOT A FAILED UPDATE.
 *
 * The updater's last step recreates the web container, so `POST
 * /api/system/update` routinely dies with no response on a run that is going
 * perfectly — and the admin page used to answer that throw with a red "update
 * failed" banner while the new version was still coming up. The errors here are
 * built with ofetch's own `createFetchError`, because the property being
 * relied on is ofetch's: a throw with no response behind it carries no
 * `statusCode`.
 */
import { describe, expect, it } from 'vitest';
import { createFetchError } from 'ofetch';

import { updateRequestWasAnswered } from '../systemUpdate';

function fetchErrorWithStatus(status: number) {
	return createFetchError({
		request: '/api/system/update',
		options: { method: 'POST' },
		response: new Response('{}', { status, statusText: 'Bad Gateway' }),
	});
}

function fetchErrorWithoutResponse(cause: Error) {
	return createFetchError({
		request: '/api/system/update',
		options: { method: 'POST' },
		error: cause,
	});
}

describe('updateRequestWasAnswered', () => {
	it('is true when the server rejected the update with a status', () => {
		expect(updateRequestWasAnswered(fetchErrorWithStatus(400))).toBe(true);
		expect(updateRequestWasAnswered(fetchErrorWithStatus(502))).toBe(true);
	});

	it('is false when the connection died before any response — the restart case', () => {
		expect(
			updateRequestWasAnswered(fetchErrorWithoutResponse(new TypeError('Failed to fetch')))
		).toBe(false);
		// Safari says neither "network" nor "fetch"; the absence of a status is
		// what this reads, so the wording of the message cannot matter.
		expect(updateRequestWasAnswered(fetchErrorWithoutResponse(new TypeError('Load failed')))).toBe(
			false
		);
	});

	it('is false for a throw that is not a fetch error at all', () => {
		expect(updateRequestWasAnswered(new Error('boom'))).toBe(false);
		expect(updateRequestWasAnswered('boom')).toBe(false);
		expect(updateRequestWasAnswered(null)).toBe(false);
		expect(updateRequestWasAnswered(undefined)).toBe(false);
	});
});
