/**
 * `isProviderAuthError` (../retryPolicy.ts): which dispatch failures say the
 * provider refused the instance's credentials.
 */
import { describe, expect, it } from 'vitest';
import { APICallError } from 'ai';
import { isProviderAuthError, isRetriableLlmError } from '../retryPolicy';
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

	it('is not a 403 that refuses the content rather than the key', () => {
		expect(
			isProviderAuthError(apiError(403, 'The request was rejected by the content policy'))
		).toBe(false);
		expect(isProviderAuthError(apiError(403, 'Blocked by the safety system'))).toBe(false);
	});
});

describe('isRetriableLlmError on a refused key', () => {
	it('does not retry a bad key reported without a status', () => {
		expect(isRetriableLlmError(new Error('Incorrect API key provided'))).toBe(false);
		expect(isRetriableLlmError(new Error('invalid x-api-key'))).toBe(false);
		expect(isRetriableLlmError({ code: 'invalid_api_key', message: 'no' })).toBe(false);
	});
});
