/**
 * Google Safe Browsing API v4 Client
 *
 * Implements the Lookup API for batch URL reputation checking.
 * https://developers.google.com/safe-browsing/v4/lookup-api
 *
 * Threat types checked:
 * - MALWARE
 * - SOCIAL_ENGINEERING (phishing)
 * - UNWANTED_SOFTWARE
 * - POTENTIALLY_HARMFUL_APPLICATION
 *
 * Free tier: 10,000 requests/day
 * Batch size: up to 500 URLs per request
 */

import type { UrlVerdict } from '../types.js';

const SAFE_BROWSING_API_URL = 'https://safebrowsing.googleapis.com/v4/threatMatches:find';
const MAX_URLS_PER_REQUEST = 500;
const REQUEST_TIMEOUT = 10000; // 10 seconds

/** Safe Browsing threat types */
const THREAT_TYPES = [
	'MALWARE',
	'SOCIAL_ENGINEERING',
	'UNWANTED_SOFTWARE',
	'POTENTIALLY_HARMFUL_APPLICATION',
] as const;

/** Safe Browsing platform types */
const PLATFORM_TYPES = [
	'ANY_PLATFORM',
] as const;

/** Safe Browsing threat entry types */
const THREAT_ENTRY_TYPES = [
	'URL',
] as const;

export interface SafeBrowsingResult {
	url: string;
	threats: string[];
	verdict: UrlVerdict;
}

interface ThreatMatch {
	threatType: string;
	platformType: string;
	threat: { url: string };
	cacheDuration: string;
	threatEntryType: string;
}

interface SafeBrowsingResponse {
	matches?: ThreatMatch[];
}

/**
 * Check URLs against Google Safe Browsing API.
 *
 * @param urls - Array of URLs to check (max 500 per call)
 * @param apiKey - Google Safe Browsing API key
 * @returns Array of results for URLs that were flagged (clean URLs are omitted)
 */
export async function checkSafeBrowsing(
	urls: string[],
	apiKey: string,
): Promise<SafeBrowsingResult[]> {
	if (urls.length === 0) return [];

	const results: SafeBrowsingResult[] = [];

	// Process in batches of MAX_URLS_PER_REQUEST
	for (let i = 0; i < urls.length; i += MAX_URLS_PER_REQUEST) {
		const batch = urls.slice(i, i + MAX_URLS_PER_REQUEST);
		const batchResults = await checkBatch(batch, apiKey);
		results.push(...batchResults);
	}

	return results;
}

/**
 * Check a single batch of URLs (max 500).
 */
async function checkBatch(
	urls: string[],
	apiKey: string,
): Promise<SafeBrowsingResult[]> {
	const requestBody = {
		client: {
			clientId: 'owlat-email-scanner',
			clientVersion: '1.0.0',
		},
		threatInfo: {
			threatTypes: [...THREAT_TYPES],
			platformTypes: [...PLATFORM_TYPES],
			threatEntryTypes: [...THREAT_ENTRY_TYPES],
			threatEntries: urls.map(url => ({ url })),
		},
	};

	const controller = new AbortController();
	const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT);

	try {
		const response = await fetch(`${SAFE_BROWSING_API_URL}?key=${apiKey}`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify(requestBody),
			signal: controller.signal,
		});

		if (!response.ok) {
			const errorText = await response.text();
			throw new Error(`Safe Browsing API error: ${response.status} ${errorText}`);
		}

		const data = await response.json() as SafeBrowsingResponse;

		if (!data.matches || data.matches.length === 0) {
			return []; // All URLs are clean
		}

		// Group matches by URL
		const matchesByUrl = new Map<string, string[]>();
		for (const match of data.matches) {
			const url = match.threat.url;
			const existing = matchesByUrl.get(url) ?? [];
			existing.push(match.threatType);
			matchesByUrl.set(url, existing);
		}

		// Convert to results
		return Array.from(matchesByUrl.entries()).map(([url, threats]) => ({
			url,
			threats,
			verdict: determineVerdict(threats),
		}));
	} finally {
		clearTimeout(timeoutId);
	}
}

/**
 * Determine verdict based on detected threat types.
 */
function determineVerdict(threats: string[]): UrlVerdict {
	if (threats.includes('MALWARE') || threats.includes('SOCIAL_ENGINEERING')) {
		return 'malicious';
	}
	if (threats.includes('UNWANTED_SOFTWARE') || threats.includes('POTENTIALLY_HARMFUL_APPLICATION')) {
		return 'suspicious';
	}
	return 'suspicious'; // Any match is at least suspicious
}

/**
 * Normalize a URL for consistent caching.
 * Strips fragments, normalizes case, removes trailing slashes.
 */
export function normalizeUrl(url: string): string {
	try {
		const parsed = new URL(url);
		parsed.hash = ''; // Remove fragment
		// Lowercase scheme and host
		let normalized = parsed.toString();
		// Remove trailing slash if it's just the path
		if (normalized.endsWith('/') && parsed.pathname === '/') {
			normalized = normalized.slice(0, -1);
		}
		return normalized;
	} catch {
		return url.toLowerCase().trim();
	}
}

/**
 * Generate a SHA-256 hash of a URL for caching.
 * Uses Web Crypto API (available in both Node.js and Convex).
 */
export async function hashUrl(url: string): Promise<string> {
	const normalized = normalizeUrl(url);
	const encoder = new TextEncoder();
	const data = encoder.encode(normalized);

	// Use Web Crypto API (works in Node.js 18+ and Convex)
	const hashBuffer = await crypto.subtle.digest('SHA-256', data);
	const hashArray = Array.from(new Uint8Array(hashBuffer));
	return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
}
