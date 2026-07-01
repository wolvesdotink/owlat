import { describe, it, expect, vi, afterEach } from 'vitest';
import { computeSpfSuggestion, fetchSpfRecords } from '../spfCoexistence';

/** Build a `fetch` stub that resolves to a Cloudflare DoH TXT response. */
function mockDohTxt(txtValues: string[]): void {
	const answer = txtValues.map((value) => ({ type: 16, data: `"${value}"` }));
	vi.stubGlobal(
		'fetch',
		vi.fn(async () => ({
			ok: true,
			json: async () => ({ Answer: answer }),
		})),
	);
}

afterEach(() => {
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
});

describe('fetchSpfRecords', () => {
	it('unwraps quoted TXT chunks and returns them', async () => {
		mockDohTxt(['v=spf1 include:_spf.google.com ~all', 'google-site-verification=abc']);
		expect(await fetchSpfRecords('example.com')).toEqual([
			'v=spf1 include:_spf.google.com ~all',
			'google-site-verification=abc',
		]);
	});

	it('joins multi-string TXT chunks for a long SPF record', async () => {
		// A record over 255 bytes is split into several quoted character-strings
		// (RFC 1035 §3.3.14); their contents concatenate with no added separator.
		vi.stubGlobal(
			'fetch',
			vi.fn(async () => ({
				ok: true,
				json: async () => ({
					Answer: [
						{ type: 16, data: '"v=spf1 include:_spf.google.com " "include:amazonses.com ~all"' },
					],
				}),
			})),
		);
		expect(await fetchSpfRecords('example.com')).toEqual([
			'v=spf1 include:_spf.google.com include:amazonses.com ~all',
		]);
	});

	it('returns [] when fetch rejects', async () => {
		vi.stubGlobal('fetch', vi.fn(async () => Promise.reject(new Error('network'))));
		expect(await fetchSpfRecords('example.com')).toEqual([]);
	});
});

describe('computeSpfSuggestion', () => {
	it('suggests a merged record when a foreign SPF already exists', async () => {
		mockDohTxt(['v=spf1 include:_spf.google.com ~all']);
		const suggestion = await computeSpfSuggestion('example.com', 'v=spf1 include:amazonses.com ~all');
		expect(suggestion).toEqual({
			existing: 'v=spf1 include:_spf.google.com ~all',
			merged: 'v=spf1 include:_spf.google.com include:amazonses.com ~all',
		});
	});

	it('returns null when no TXT / SPF record is published', async () => {
		mockDohTxt(['google-site-verification=abc']);
		expect(await computeSpfSuggestion('example.com', 'v=spf1 include:amazonses.com ~all')).toBeNull();
	});

	it('returns null when the existing record already carries our mechanisms', async () => {
		mockDohTxt(['v=spf1 include:_spf.google.com include:amazonses.com ~all']);
		expect(await computeSpfSuggestion('example.com', 'v=spf1 include:amazonses.com ~all')).toBeNull();
	});

	it('returns null (fail-soft) when fetch rejects', async () => {
		vi.stubGlobal('fetch', vi.fn(async () => Promise.reject(new Error('network'))));
		expect(await computeSpfSuggestion('example.com', 'v=spf1 include:amazonses.com ~all')).toBeNull();
	});
});
