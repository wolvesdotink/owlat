/**
 * URL reputation provider abstraction.
 *
 * Google Safe Browsing is the default; swapping to VirusTotal, urlscan.io,
 * or a custom internal list is one adapter away.
 */

import type { UrlReputationResult } from '../types.js';
import { checkSafeBrowsing } from './safeBrowsing.js';

export type UrlReputationProviderType = 'safe-browsing' | 'noop';

/**
 * URL reputation provider interface. Batches are typed as Promise<map>
 * (url → verdict) so callers can iterate at their own pace.
 */
export interface UrlReputationProvider {
	getProviderName(): UrlReputationProviderType;
	check(urls: string[], opts?: { apiKey?: string }): Promise<UrlReputationResult[]>;
}

export function createSafeBrowsingProvider(): UrlReputationProvider {
	return {
		getProviderName: () => 'safe-browsing',
		async check(urls, opts) {
			if (!opts?.apiKey) {
				// No API key configured: pretend everything is safe and let
				// downstream consumers (content scanner) decide if that's OK.
				return urls.map((url) => ({ url, verdict: 'safe' as const, source: 'safe-browsing' }));
			}
			const results = await checkSafeBrowsing(urls, opts.apiKey);
			return results.map((r) => ({
				url: r.url,
				verdict: r.verdict,
				source: 'safe-browsing',
				threats: r.threats,
			}));
		},
	};
}

export function createNoopUrlReputationProvider(): UrlReputationProvider {
	return {
		getProviderName: () => 'noop',
		async check(urls) {
			return urls.map((url) => ({ url, verdict: 'safe' as const, source: 'noop' }));
		},
	};
}

let cached: UrlReputationProvider | null = null;
let cachedType: UrlReputationProviderType | null = null;

/**
 * Reads URL_REPUTATION_PROVIDER (defaults to 'safe-browsing') and returns
 * the cached adapter.
 */
export function getUrlReputationProvider(): UrlReputationProvider {
	const type = ((typeof process !== 'undefined' && process.env?.['URL_REPUTATION_PROVIDER']) ??
		'safe-browsing') as UrlReputationProviderType;

	if (cached && cachedType === type) return cached;

	switch (type) {
		case 'safe-browsing':
			cached = createSafeBrowsingProvider();
			cachedType = 'safe-browsing';
			break;
		case 'noop':
			cached = createNoopUrlReputationProvider();
			cachedType = 'noop';
			break;
		default:
			throw new Error(
				`Unknown URL reputation provider: ${type}. Supported: safe-browsing, noop`,
			);
	}
	return cached;
}

export function clearUrlReputationProviderCache(): void {
	cached = null;
	cachedType = null;
}
