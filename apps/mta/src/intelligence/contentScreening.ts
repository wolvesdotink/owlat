/**
 * Content Pre-Screening
 *
 * Pluggable content inspection step that runs before all other intelligence
 * checks. Catches malformed or dangerous content before it damages IP reputation.
 */

import type Redis from 'ioredis';
import { extractDomainOrNull } from '@owlat/shared';
import { isIdentifierAligned } from '@owlat/shared/spfAlignment';
import type { EmailJob } from '../types.js';
import type { MtaConfig } from '../config.js';
import { logger } from '../monitoring/logger.js';

const URL_BLOCKLIST_KEY = 'mta:screening:url-blocklist';

export interface ScreeningResult {
	allowed: boolean;
	reason?: string;
}

/**
 * Screen email content for basic safety checks.
 *
 * Returns { allowed: true } if content passes all checks.
 * Returns { allowed: false, reason } if content should be rejected.
 */
export async function screenContent(
	redis: Redis,
	job: EmailJob,
	config: MtaConfig
): Promise<ScreeningResult> {
	// 1. Empty body check
	if (!job.html && !job.text) {
		return { allowed: false, reason: 'empty_body' };
	}

	// 2. Required fields check
	if (!job.from || job.from.trim() === '') {
		return { allowed: false, reason: 'missing_from' };
	}
	if (!job.subject || job.subject.trim() === '') {
		return { allowed: false, reason: 'missing_subject' };
	}

	// 3. DKIM domain alignment check
	const fromDomain = extractDomainOrNull(job.from);
	if (fromDomain && job.dkimDomain) {
		// DMARC relaxed alignment (RFC 7489 §3.1.1): d= and From must share the
		// PSL-derived Organizational Domain, so sibling subdomains align but
		// tenants under a private suffix such as github.io do not.
		if (!isIdentifierAligned(job.dkimDomain, fromDomain)) {
			return { allowed: false, reason: 'dkim_misalignment' };
		}
	}

	// 4. Size budget check
	const maxSizeBytes = config.contentMaxSizeKb * 1024;
	const htmlSize = job.html ? Buffer.byteLength(job.html, 'utf-8') : 0;
	if (htmlSize > maxSizeBytes) {
		return {
			allowed: false,
			reason: `content_too_large:${Math.round(htmlSize / 1024)}KB>${config.contentMaxSizeKb}KB`,
		};
	}

	// 5. URL blocklist check (if URLs in HTML)
	if (job.html) {
		const blockedUrl = await checkUrlBlocklist(redis, job.html);
		if (blockedUrl) {
			return { allowed: false, reason: `blocked_url:${blockedUrl}` };
		}
	}

	// 6. Rspamd spam scoring (optional — requires RSPAMD_URL)
	if (config.rspamdUrl) {
		const spamResult = await checkRspamd(config.rspamdUrl, job, config.rspamdRejectThreshold);
		if (spamResult) {
			return spamResult;
		}
	}

	return { allowed: true };
}

/**
 * Check HTML content against URL blocklist in Redis
 */
async function checkUrlBlocklist(redis: Redis, html: string): Promise<string | null> {
	// Extract URLs from HTML
	const urlPattern = /https?:\/\/[^\s"'<>]+/gi;
	const urls = html.match(urlPattern);
	if (!urls || urls.length === 0) return null;

	// Get blocklist from Redis (cached patterns)
	const blocklist = await redis.smembers(URL_BLOCKLIST_KEY);
	if (blocklist.length === 0) return null;

	// Check each URL against blocklist patterns
	for (const url of urls) {
		const urlLower = url.toLowerCase();
		for (const pattern of blocklist) {
			if (urlLower.includes(pattern.toLowerCase())) {
				return pattern;
			}
		}
	}

	return null;
}

/**
 * Add a URL pattern to the blocklist
 */
export async function addToUrlBlocklist(redis: Redis, pattern: string): Promise<void> {
	await redis.sadd(URL_BLOCKLIST_KEY, pattern.toLowerCase());
	logger.info({ pattern }, 'URL pattern added to screening blocklist');
}

/**
 * Remove a URL pattern from the blocklist
 */
export async function removeFromUrlBlocklist(redis: Redis, pattern: string): Promise<void> {
	await redis.srem(URL_BLOCKLIST_KEY, pattern.toLowerCase());
	logger.info({ pattern }, 'URL pattern removed from screening blocklist');
}

/**
 * List all URL blocklist patterns
 */
export async function getUrlBlocklist(redis: Redis): Promise<string[]> {
	return redis.smembers(URL_BLOCKLIST_KEY);
}

// ─── Rspamd Integration ────────────────────────────────────────────

interface RspamdResponse {
	score: number;
	required_score: number;
	action: 'no action' | 'greylist' | 'add header' | 'rewrite subject' | 'soft reject' | 'reject';
	symbols?: Record<string, { score: number; description?: string }>;
}

/**
 * Check content against rspamd HTTP API for spam scoring.
 *
 * @returns ScreeningResult if spam detected, null if content is clean
 */
async function checkRspamd(
	rspamdUrl: string,
	job: EmailJob,
	rejectThreshold: number
): Promise<ScreeningResult | null> {
	try {
		// Build a minimal RFC 822 message for rspamd
		const message = [
			`From: ${job.from}`,
			`To: ${job.to}`,
			`Subject: ${job.subject}`,
			'MIME-Version: 1.0',
			'Content-Type: text/html; charset=utf-8',
			'',
			job.html || job.text || '',
		].join('\r\n');

		const controller = new AbortController();
		const timeout = setTimeout(() => controller.abort(), 5000); // 5s timeout

		try {
			const response = await fetch(`${rspamdUrl}/checkv2`, {
				method: 'POST',
				headers: {
					'Content-Type': 'message/rfc822',
				},
				body: message,
				signal: controller.signal,
			});

			if (!response.ok) {
				logger.warn({ status: response.status }, 'Rspamd returned non-OK status');
				return null; // Fail open
			}

			const result = (await response.json()) as RspamdResponse;

			if (result.score >= rejectThreshold) {
				logger.warn(
					{
						messageId: job.messageId,
						score: result.score,
						threshold: rejectThreshold,
						action: result.action,
					},
					'Rspamd rejected — spam score too high'
				);
				return {
					allowed: false,
					reason: `spam_score:${result.score.toFixed(1)}>${rejectThreshold}`,
				};
			}

			// Log warning-level scores but allow through
			if (result.action !== 'no action') {
				logger.info(
					{ messageId: job.messageId, score: result.score, action: result.action },
					'Rspamd flagged content (below reject threshold)'
				);
			}

			return null; // Content is clean
		} finally {
			clearTimeout(timeout);
		}
	} catch (err) {
		// Fail open — don't block delivery due to rspamd errors
		logger.warn({ err }, 'Rspamd check failed — allowing content through');
		return null;
	}
}
