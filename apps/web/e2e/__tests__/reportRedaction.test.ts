// @vitest-environment node
/**
 * What the suite itself writes into the public report (the setup's console and
 * network log, error messages) names neither the deployment nor a JWT (#1222).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
	describeRequest,
	redactForReport,
	testDeployments,
	unreachableError,
} from '../reportRedaction';

const DEPLOYMENTS = {
	convex: 'https://dummy-deployment-7c1e.example.invalid',
	'convex-site': 'https://dummy-site-7c1e.example.invalid/',
	unset: undefined,
};
const JWT = 'eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJkdW1teS11c2VyIn0.ZHVtbXktc2lnbmF0dXJl';

afterEach(() => {
	vi.unstubAllEnvs();
});

describe('redactForReport', () => {
	it('replaces a deployment host in any scheme, in any case, and bare', () => {
		const text = [
			"WebSocket connection to 'wss://dummy-deployment-7c1e.example.invalid/api/sync' failed",
			'GET https://DUMMY-SITE-7C1E.example.invalid/api/auth/get-session 500',
			'getaddrinfo ENOTFOUND dummy-deployment-7c1e.example.invalid',
		].join('\n');

		expect(redactForReport(text, DEPLOYMENTS)).toBe(
			[
				"WebSocket connection to 'wss://[convex]/api/sync' failed",
				'GET https://[convex-site]/api/auth/get-session 500',
				'getaddrinfo ENOTFOUND [convex]',
			].join('\n')
		);
	});

	it('replaces a JWT', () => {
		expect(redactForReport(`Authorization: Bearer ${JWT}`, DEPLOYMENTS)).toBe(
			'Authorization: Bearer [JWT]'
		);
	});

	it('leaves other text alone, a host that only contains a dot included', () => {
		const text = 'markWelcomed failed: dummy-deployment-7c1eXexample.invalid';
		expect(redactForReport(text, DEPLOYMENTS)).toBe(text);
	});
});

describe('describeRequest', () => {
	it('keeps the method, the redacted origin, the path and the outcome, and drops the query', () => {
		expect(
			describeRequest(
				{
					method: 'GET',
					url: 'https://dummy-site-7c1e.example.invalid/api/auth/convex/token?code=dummy',
					outcome: '200 41 ms',
				},
				DEPLOYMENTS
			)
		).toBe('GET https://[convex-site]/api/auth/convex/token 200 41 ms');
	});
});

describe('testDeployments', () => {
	it('reads the deployment URLs the workflow hands the suite', () => {
		vi.stubEnv('NUXT_PUBLIC_CONVEX_URL', DEPLOYMENTS.convex);
		vi.stubEnv('NUXT_PUBLIC_CONVEX_SITE_URL', DEPLOYMENTS['convex-site']);

		expect(testDeployments()).toEqual({
			convex: DEPLOYMENTS.convex,
			'convex-site': DEPLOYMENTS['convex-site'],
		});
	});
});

describe('unreachableError', () => {
	it('keeps the code of a network error and drops its cause, which names the host', () => {
		const cause = Object.assign(
			new Error('getaddrinfo ENOTFOUND dummy-deployment-7c1e.example.invalid'),
			{ code: 'ENOTFOUND' }
		);
		const error = unreachableError('POST /dev/reset', new TypeError('fetch failed', { cause }));

		expect(error.message).toBe('POST /dev/reset did not reach the deployment (ENOTFOUND).');
		expect(error.cause).toBeUndefined();
	});

	it('names a timeout', () => {
		const timeout = new DOMException('The operation timed out.', 'TimeoutError');
		expect(unreachableError('POST /dev/reset', timeout).message).toBe('POST /dev/reset timed out.');
	});
});
