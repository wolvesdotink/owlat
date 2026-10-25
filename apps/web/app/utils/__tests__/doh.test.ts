import { afterEach, describe, expect, it, vi } from 'vitest';
import { dohQuery } from '../doh';

function answering(body: unknown) {
	vi.stubGlobal(
		'fetch',
		vi.fn(async () => new Response(JSON.stringify(body), { status: 200 }))
	);
}

const originalFetch = globalThis.fetch;
afterEach(() => {
	// Not unstubAllGlobals: the setup file's Nuxt auto-imports are stubbed globals too.
	globalThis.fetch = originalFetch;
});

describe('dohQuery', () => {
	it('returns a DoH answer, extra record fields included', async () => {
		const body = {
			Status: 0,
			Answer: [{ name: 'example.com', type: 16, TTL: 300, data: '"v=spf1 -all"' }],
		};
		answering(body);
		await expect(dohQuery('example.com', 'TXT')).resolves.toEqual(body);
	});

	it('returns an answer without records (NXDOMAIN)', async () => {
		answering({ Status: 3 });
		await expect(dohQuery('missing.example.com', 'TXT')).resolves.toEqual({ Status: 3 });
	});

	it.each([
		['a non-numeric status', { Status: 'NOERROR' }],
		['records that are not a list', { Status: 0, Answer: { type: 16, data: 'x' } }],
		['a record without data', { Status: 0, Answer: [{ type: 16 }] }],
		['a record with a non-numeric type', { Status: 0, Answer: [{ type: 'TXT', data: 'x' }] }],
		['a list', [{ type: 16, data: 'x' }]],
		['null', null],
	])('returns null for a body with %s', async (_case, body) => {
		answering(body);
		await expect(dohQuery('example.com', 'TXT')).resolves.toBeNull();
	});

	it('returns null for a body that is not JSON', async () => {
		vi.stubGlobal(
			'fetch',
			vi.fn(async () => new Response('<html>', { status: 200 }))
		);
		await expect(dohQuery('example.com', 'TXT')).resolves.toBeNull();
	});
});
