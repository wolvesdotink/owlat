/**
 * `isProviderAuthError` (../retryPolicy.ts): which dispatch failures say the
 * provider refused the instance's credentials.
 */
import { describe, expect, it } from 'vitest';
import { APICallError } from 'ai';
import { isProviderAuthError } from '../retryPolicy';
import { LlmPartialUsageError } from '../partialUsage';

function apiError(statusCode: number, message = 'provider error') {
	return new APICallError({
		message,
		url: 'https://provider.test',
		requestBodyValues: {},
		statusCode,
	});
}

describe('isProviderAuthError', () => {
	it('is a 401 or 403 from the provider', () => {
		expect(isProviderAuthError(apiError(401))).toBe(true);
		expect(isProviderAuthError(apiError(403))).toBe(true);
	});

	it('looks through a failure that carried billed usage', () => {
		const usage = { promptTokens: 1, completionTokens: 0, totalTokens: 1 };
		expect(isProviderAuthError(new LlmPartialUsageError(apiError(401), usage, 'm'))).toBe(true);
	});

	it('reads a bad-key message without a status', () => {
		expect(isProviderAuthError(new Error('Invalid API key'))).toBe(true);
		expect(isProviderAuthError({ code: 'invalid_api_key', message: 'no' })).toBe(true);
	});

	it('is not a rate limit, an outage, a bad request or a plain error', () => {
		expect(isProviderAuthError(apiError(429))).toBe(false);
		expect(isProviderAuthError(apiError(503))).toBe(false);
		expect(isProviderAuthError(apiError(400, 'Invalid API key'))).toBe(false);
		expect(isProviderAuthError(new Error('provider down'))).toBe(false);
		expect(isProviderAuthError(undefined)).toBe(false);
	});
});
