/**
 * A DROPPED REQUEST IS NOT A FAILED UPDATE.
 *
 * The updater's last step recreates the web container, so `POST
 * /api/system/update` routinely dies on a run that is going perfectly — and the
 * admin page answered that with a red "update failed" banner while the new
 * version was still coming up.
 *
 * The first attempt at this read the presence of an HTTP status: no response,
 * no verdict. That is not how the request dies. Caddy notices its upstream
 * disappear and answers the browser with a bodiless 502, which is a status like
 * any other — and a 0.5.2 → 0.5.3 update that succeeded end to end still
 * reported `[POST] "/api/system/update": 502` in red. The route's own
 * updater-reported failure is a 502 too, so the number cannot separate them and
 * the body has to: ours carries the sidecar's report, the proxy's carries
 * nothing.
 *
 * The errors here are built with ofetch's own `createFetchError` because the
 * properties being relied on are ofetch's.
 */
import { describe, expect, it } from 'vitest';
import { createFetchError } from 'ofetch';

import {
	UPDATER_REPORT_MARKER,
	updateFailureMessage,
	updateRequestWasAnswered,
} from '../systemUpdate';

function fetchError(status: number, body?: unknown, statusText = 'Bad Gateway') {
	const response = new Response(body === undefined ? '' : JSON.stringify(body), {
		status,
		statusText,
	});
	// `FetchError.data` reads the body ofetch already parsed onto the response,
	// so a hand-built Response has to carry it the same way.
	Object.assign(response, { _data: body === undefined ? '' : body });
	return createFetchError({
		request: '/api/system/update',
		options: { method: 'POST' },
		response,
	});
}

/** What Caddy sends when `web` is recreated mid-request: a 502 and nothing else. */
function proxy502() {
	return fetchError(502);
}

/** What the route sends when the sidecar reports a failed rollout. */
function routeFailure(error: string) {
	return fetchError(502, {
		statusCode: 502,
		statusMessage: error,
		message: error,
		data: {
			[UPDATER_REPORT_MARKER]: true,
			error,
			steps: [{ step: 'up', ok: false, stdout: '', stderr: 'the retry failed' }],
		},
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
	it('is false for the proxy 502 that a SUCCESSFUL update produces', () => {
		expect(updateRequestWasAnswered(proxy502())).toBe(false);
		// A proxy that waited instead of noticing gets the same reading.
		expect(updateRequestWasAnswered(fetchError(504, undefined, 'Gateway Timeout'))).toBe(false);
	});

	it('is true for the 502 the route itself throws, which carries the report', () => {
		expect(updateRequestWasAnswered(routeFailure('docker compose up failed'))).toBe(true);
	});

	it('is true for statuses no proxy invents', () => {
		// Rejected version, missing instance secret, session that is not an
		// admin's — all conclusive without a body.
		expect(updateRequestWasAnswered(fetchError(400, undefined, 'Bad Request'))).toBe(true);
		expect(updateRequestWasAnswered(fetchError(403, undefined, 'Forbidden'))).toBe(true);
		expect(updateRequestWasAnswered(fetchError(503, undefined, 'Service Unavailable'))).toBe(true);
	});

	it('is false when the connection died before any response', () => {
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

describe('updateFailureMessage', () => {
	it('uses the sidecar’s reason rather than the status line', () => {
		const message = updateFailureMessage(routeFailure('convex-deploy failed'), 'Unknown error');
		expect(message).toBe('convex-deploy failed');
		// The status line is what the banner used to show, and all of it.
		expect(message).not.toContain('502');
	});

	it('falls back to the error envelope’s message when there is no report', () => {
		const error = fetchError(400, {
			statusCode: 400,
			message: 'Invalid targetVersion (expected semver like 1.2.3)',
		});
		expect(updateFailureMessage(error, 'Unknown error')).toBe(
			'Invalid targetVersion (expected semver like 1.2.3)'
		);
	});

	it('falls back to the caller’s text when the throw says nothing useful', () => {
		expect(updateFailureMessage({}, 'Unknown error')).toBe('Unknown error');
		expect(updateFailureMessage(null, 'Unknown error')).toBe('Unknown error');
	});
});
