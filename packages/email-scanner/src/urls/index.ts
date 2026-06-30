/**
 * URL Reputation Checking — Main Orchestrator
 *
 * Combines Google Safe Browsing API lookups with caching to provide
 * URL reputation checking for email content.
 */

import type { ContentFlag, UrlReputationResult, UrlReputationCache } from '../types.js';
import { checkSafeBrowsing, hashUrl, normalizeUrl } from './safeBrowsing.js';
import { createCachedVerdict } from './cache.js';
import { extractUrls } from '../content/phishingUrls.js';

export interface UrlReputationOptions {
	/** Google Safe Browsing API key */
	apiKey: string;
	/** Cache implementation */
	cache?: UrlReputationCache;
}

/**
 * Check URL reputation for all links in HTML content.
 *
 * @param htmlContent - Email HTML content to extract URLs from
 * @param options - API key and optional cache
 * @returns Array of reputation results for flagged URLs
 */
export async function checkUrlReputation(
	htmlContent: string,
	options: UrlReputationOptions,
): Promise<UrlReputationResult[]> {
	// Extract all URLs from HTML
	const links = extractUrls(htmlContent);
	const urls = links
		.map(l => l.href)
		.filter(href => href.startsWith('http://') || href.startsWith('https://'));

	if (urls.length === 0) return [];

	// Deduplicate URLs
	const uniqueUrls = [...new Set(urls.map(normalizeUrl))];

	return checkUrlReputationBatch(uniqueUrls, options);
}

/**
 * Check a batch of URLs for reputation.
 *
 * @param urls - Array of URLs to check
 * @param options - API key and optional cache
 * @returns Array of reputation results for flagged URLs
 */
export async function checkUrlReputationBatch(
	urls: string[],
	options: UrlReputationOptions,
): Promise<UrlReputationResult[]> {
	if (urls.length === 0) return [];

	const results: UrlReputationResult[] = [];
	const uncachedUrls: string[] = [];

	// Check cache first
	if (options.cache) {
		for (const url of urls) {
			const hash = await hashUrl(url);
			const cached = await options.cache.get(hash);

			if (cached) {
				if (cached.verdict !== 'safe') {
					results.push({
						url,
						verdict: cached.verdict,
						source: cached.source,
						threats: cached.threats,
					});
				}
				// Skip this URL — it's cached (whether safe or not)
				continue;
			}

			uncachedUrls.push(url);
		}
	} else {
		uncachedUrls.push(...urls);
	}

	if (uncachedUrls.length === 0) return results;

	// Check uncached URLs against Safe Browsing
	try {
		const sbResults = await checkSafeBrowsing(uncachedUrls, options.apiKey);

		// Create a set of flagged URLs for quick lookup
		const flaggedUrls = new Set(sbResults.map(r => normalizeUrl(r.url)));

		// Cache all results (both clean and flagged)
		if (options.cache) {
			// Cache flagged URLs
			for (const sbResult of sbResults) {
				const hash = await hashUrl(sbResult.url);
				await options.cache.set(hash, createCachedVerdict(
					sbResult.verdict,
					'google_safe_browsing',
					sbResult.threats,
				));
			}

			// Cache clean URLs
			for (const url of uncachedUrls) {
				if (!flaggedUrls.has(normalizeUrl(url))) {
					const hash = await hashUrl(url);
					await options.cache.set(hash, createCachedVerdict(
						'safe',
						'google_safe_browsing',
					));
				}
			}
		}

		// Add flagged results
		for (const sbResult of sbResults) {
			results.push({
				url: sbResult.url,
				verdict: sbResult.verdict,
				source: 'google_safe_browsing',
				threats: sbResult.threats,
			});
		}
	} catch (error) {
		// Safe Browsing API failure — log but don't block
		// The content scanner's regex-based checks still apply
		const message = error instanceof Error ? error.message : String(error);
		// eslint-disable-next-line no-console
		console.warn(`[url-reputation] Safe Browsing API check failed: ${message}`);
	}

	return results;
}

/**
 * Convert URL reputation results into content flags.
 */
export function urlReputationToFlags(results: UrlReputationResult[]): ContentFlag[] {
	const flags: ContentFlag[] = [];

	for (const result of results) {
		if (result.verdict === 'malicious') {
			flags.push({
				type: 'malicious_url',
				severity: 'high',
				description: `URL flagged as malicious by ${result.source}: ${result.url} (${result.threats?.join(', ') ?? 'unknown threat'})`,
				match: result.url,
			});
		} else if (result.verdict === 'suspicious') {
			flags.push({
				type: 'malicious_url',
				severity: 'medium',
				description: `URL flagged as suspicious by ${result.source}: ${result.url} (${result.threats?.join(', ') ?? 'unknown threat'})`,
				match: result.url,
			});
		}
	}

	return flags;
}

// Re-export
export { checkSafeBrowsing, hashUrl, normalizeUrl } from './safeBrowsing.js';
export { createCachedVerdict, isExpired, InMemoryUrlCache, CLEAN_TTL_MS, FLAGGED_TTL_MS } from './cache.js';
