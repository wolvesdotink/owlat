import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { checkSafeBrowsing, normalizeUrl, hashUrl } from '../urls/safeBrowsing.js';
import { InMemoryUrlCache, isExpired, createCachedVerdict, CLEAN_TTL_MS, FLAGGED_TTL_MS } from '../urls/cache.js';
import { checkUrlReputation, urlReputationToFlags } from '../urls/index.js';

describe('URL reputation checking', () => {
	describe('normalizeUrl', () => {
		it('removes fragments', () => {
			expect(normalizeUrl('https://example.com/page#section')).not.toContain('#section');
		});

		it('handles trailing slashes consistently', () => {
			const a = normalizeUrl('https://example.com');
			const b = normalizeUrl('https://example.com/');
			expect(a).toBe(b);
		});

		it('handles malformed URLs gracefully', () => {
			expect(normalizeUrl('not-a-url')).toBe('not-a-url');
		});
	});

	describe('hashUrl', () => {
		it('returns a hex string', async () => {
			const hash = await hashUrl('https://example.com');
			expect(hash).toMatch(/^[0-9a-f]{64}$/);
		});

		it('returns consistent hashes for same URL', async () => {
			const hash1 = await hashUrl('https://example.com');
			const hash2 = await hashUrl('https://example.com');
			expect(hash1).toBe(hash2);
		});

		it('normalizes before hashing', async () => {
			const hash1 = await hashUrl('https://example.com');
			const hash2 = await hashUrl('https://example.com/');
			expect(hash1).toBe(hash2);
		});
	});

	describe('InMemoryUrlCache', () => {
		it('stores and retrieves verdicts', async () => {
			const cache = new InMemoryUrlCache();
			const verdict = createCachedVerdict('safe', 'test');

			await cache.set('hash1', verdict);
			const result = await cache.get('hash1');

			expect(result).not.toBeNull();
			expect(result!.verdict).toBe('safe');
		});

		it('returns null for missing entries', async () => {
			const cache = new InMemoryUrlCache();
			expect(await cache.get('nonexistent')).toBeNull();
		});

		it('returns null for expired entries', async () => {
			const cache = new InMemoryUrlCache();
			const verdict = createCachedVerdict('safe', 'test');
			verdict.expiresAt = Date.now() - 1000; // Expired

			await cache.set('hash1', verdict);
			expect(await cache.get('hash1')).toBeNull();
		});
	});

	describe('createCachedVerdict', () => {
		it('uses longer TTL for safe verdicts', () => {
			const verdict = createCachedVerdict('safe', 'test');
			const ttl = verdict.expiresAt - verdict.checkedAt;
			expect(ttl).toBe(CLEAN_TTL_MS);
		});

		it('uses shorter TTL for malicious verdicts', () => {
			const verdict = createCachedVerdict('malicious', 'test', ['MALWARE']);
			const ttl = verdict.expiresAt - verdict.checkedAt;
			expect(ttl).toBe(FLAGGED_TTL_MS);
		});
	});

	describe('isExpired', () => {
		it('returns false for non-expired verdict', () => {
			const verdict = createCachedVerdict('safe', 'test');
			expect(isExpired(verdict)).toBe(false);
		});

		it('returns true for expired verdict', () => {
			const verdict = createCachedVerdict('safe', 'test');
			verdict.expiresAt = Date.now() - 1;
			expect(isExpired(verdict)).toBe(true);
		});
	});

	describe('checkSafeBrowsing', () => {
		const originalFetch = globalThis.fetch;

		afterEach(() => {
			globalThis.fetch = originalFetch;
		});

		it('returns empty for empty URL list', async () => {
			const results = await checkSafeBrowsing([], 'test-key');
			expect(results).toHaveLength(0);
		});

		it('returns empty when API reports no threats', async () => {
			globalThis.fetch = vi.fn().mockResolvedValue({
				ok: true,
				json: () => Promise.resolve({}),
			});

			const results = await checkSafeBrowsing(['https://google.com'], 'test-key');
			expect(results).toHaveLength(0);
		});

		it('returns malicious for flagged URLs', async () => {
			globalThis.fetch = vi.fn().mockResolvedValue({
				ok: true,
				json: () => Promise.resolve({
					matches: [{
						threatType: 'SOCIAL_ENGINEERING',
						platformType: 'ANY_PLATFORM',
						threat: { url: 'https://phishing-site.com' },
						cacheDuration: '300s',
						threatEntryType: 'URL',
					}],
				}),
			});

			const results = await checkSafeBrowsing(['https://phishing-site.com'], 'test-key');
			expect(results).toHaveLength(1);
			expect(results[0]!.verdict).toBe('malicious');
			expect(results[0]!.threats).toContain('SOCIAL_ENGINEERING');
		});

		it('throws on API error', async () => {
			globalThis.fetch = vi.fn().mockResolvedValue({
				ok: false,
				status: 403,
				text: () => Promise.resolve('Forbidden'),
			});

			await expect(checkSafeBrowsing(['https://example.com'], 'bad-key'))
				.rejects.toThrow('Safe Browsing API error: 403');
		});
	});

	describe('urlReputationToFlags', () => {
		it('creates high-severity flag for malicious URLs', () => {
			const flags = urlReputationToFlags([{
				url: 'https://evil.com',
				verdict: 'malicious',
				source: 'google_safe_browsing',
				threats: ['MALWARE'],
			}]);

			expect(flags).toHaveLength(1);
			expect(flags[0]!.type).toBe('malicious_url');
			expect(flags[0]!.severity).toBe('high');
		});

		it('creates medium-severity flag for suspicious URLs', () => {
			const flags = urlReputationToFlags([{
				url: 'https://sketchy.com',
				verdict: 'suspicious',
				source: 'google_safe_browsing',
				threats: ['UNWANTED_SOFTWARE'],
			}]);

			expect(flags).toHaveLength(1);
			expect(flags[0]!.severity).toBe('medium');
		});

		it('returns empty for safe URLs', () => {
			const flags = urlReputationToFlags([{
				url: 'https://safe.com',
				verdict: 'safe',
				source: 'google_safe_browsing',
			}]);

			expect(flags).toHaveLength(0);
		});
	});

	describe('checkUrlReputation', () => {
		const originalFetch = globalThis.fetch;

		afterEach(() => {
			globalThis.fetch = originalFetch;
		});

		it('extracts and checks URLs from HTML', async () => {
			globalThis.fetch = vi.fn().mockResolvedValue({
				ok: true,
				json: () => Promise.resolve({}),
			});

			const results = await checkUrlReputation(
				'<html><body><a href="https://example.com">Link</a></body></html>',
				{ apiKey: 'test-key' }
			);

			expect(results).toHaveLength(0); // No threats found
			expect(globalThis.fetch).toHaveBeenCalled();
		});

		it('returns empty for HTML with no links', async () => {
			const results = await checkUrlReputation(
				'<html><body><p>No links here</p></body></html>',
				{ apiKey: 'test-key' }
			);

			expect(results).toHaveLength(0);
		});

		it('uses cache when provided', async () => {
			const cache = new InMemoryUrlCache();
			const hash = await hashUrl('https://cached-evil.com');
			await cache.set(hash, createCachedVerdict('malicious', 'test', ['MALWARE']));

			// Fetch should NOT be called for cached URL
			globalThis.fetch = vi.fn();

			const results = await checkUrlReputation(
				'<html><body><a href="https://cached-evil.com">Click</a></body></html>',
				{ apiKey: 'test-key', cache }
			);

			expect(results).toHaveLength(1);
			expect(results[0]!.verdict).toBe('malicious');
			expect(globalThis.fetch).not.toHaveBeenCalled();
		});
	});
});
