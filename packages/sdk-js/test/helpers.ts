import { vi } from 'vitest';
import { Owlat } from '../src';

const TEST_BASE_URL = 'https://api.test.owlat.app';
const TEST_API_KEY = 'lm_test_key';

export function createTestClient(): Owlat {
	return new Owlat({
		apiKey: TEST_API_KEY,
		baseUrl: TEST_BASE_URL,
	});
}

export interface MockFetchOptions {
	status?: number;
	body?: unknown;
	headers?: Record<string, string>;
}

export function mockFetch(options: MockFetchOptions = {}) {
	const { status = 200, body, headers = {} } = options;

	const responseHeaders = new Headers(headers);
	const hasBody = body !== undefined;
	const responseBody = hasBody ? JSON.stringify(body) : null;

	const mockFn = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
		new Response(responseBody, {
			status,
			headers: responseHeaders,
		})
	);

	return mockFn;
}

export function mockFetchError(error: Error) {
	return vi.spyOn(globalThis, 'fetch').mockRejectedValue(error);
}

export const TEST_RATE_LIMIT_HEADERS: Record<string, string> = {
	'X-RateLimit-Limit': '100',
	'X-RateLimit-Remaining': '99',
	'X-RateLimit-Reset': '1700000000',
};
