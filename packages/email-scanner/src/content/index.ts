/**
 * Content Scanner — Main Orchestrator
 *
 * Built-in scan rules (spam keywords, phishing URLs, homoglyphs, subject
 * analysis, prohibited content) register themselves via the contentRules
 * registry when their modules are loaded. scanContent() iterates the
 * registry instead of calling each rule directly, which lets third
 * parties install additional rules through registerContentRule().
 *
 * Import order below determines registration order, which determines flag
 * iteration order — kept identical to the historical hand-coded order so
 * existing snapshots and behavior tests stay green.
 */

import type { ContentFlag, ContentScanResult, ContentScanLevel } from '../types.js';
import { contentRules, type ScanInput } from './rule.js';
import { extractUrls } from './phishingUrls.js';
import { decodeHtmlEntities } from './htmlEntities.js';

// Side-effect imports — each module registers its rule(s) at load time.
// Order matches the legacy in-line orchestration in this file:
//   spam-keywords → phishing-urls → homoglyphs
//     → caps-abuse + excessive-punctuation (both from subjectAnalysis)
//     → prohibited-content
import './spamKeywords.js';
import './phishingUrls.js';
import './homoglyphs.js';
import './subjectAnalysis.js';
import './prohibitedContent.js';
// Header-aware rule — no-ops unless scanContent is given From/Reply-To. Ordered
// last so its flags append after the body/URL rules (stable iteration order).
import './senderImpersonation.js';

/**
 * Strip HTML tags to get plain text for keyword scanning.
 */
function stripHtml(html: string): string {
	const withoutMarkup = html
		.replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '') // Remove style blocks
		.replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '') // Remove script blocks
		.replace(/<!--[\s\S]*?-->/g, '') // Remove comments
		.replace(/<[^>]+>/g, ' ') // Remove all HTML tags
		.replace(/&nbsp;/gi, ' ');
	return decodeHtmlEntities(withoutMarkup).replace(/\s+/g, ' ').trim();
}

/**
 * Calculate a numeric score from content flags based on severity.
 */
function calculateScore(flags: ContentFlag[]): number {
	let score = 0;
	for (const flag of flags) {
		switch (flag.severity) {
			case 'high':
				score += 20;
				break;
			case 'medium':
				score += 10;
				break;
			case 'low':
				score += 3;
				break;
		}
	}
	return Math.min(100, score);
}

/**
 * Determine the content-scan level from a 0–100 score. Exported as the single
 * source of truth for the score→level boundaries so callers that combine scores
 * (e.g. the campaign send path adds a URL-reputation score) classify the result
 * the same way the scanner does instead of re-implementing the thresholds.
 */
export function levelForScore(score: number): ContentScanLevel {
	if (score >= 40) return 'blocked';
	if (score >= 15) return 'suspicious';
	return 'clean';
}

/**
 * Scan email content for spam, phishing, homoglyph spoofing, and prohibited patterns.
 *
 * Pre-processes the inputs once (HTML strip, URL extraction) then dispatches
 * to every rule installed in the contentRules registry. Rule errors do not
 * abort the scan — the failing rule is skipped so a misbehaving plugin
 * cannot silently drop legitimate flags from healthy rules.
 *
 * @param subject - Email subject line
 * @param htmlContent - Email HTML body content
 * @param headers - Optional message headers (`from`, `replyTo`) for the
 *   header-aware rules (sender-impersonation). Omitted by legacy callers, in
 *   which case those rules no-op.
 * @returns ContentScanResult with score, flags, and level
 */
export function scanContent(
	subject: string,
	htmlContent: string,
	headers?: { from?: string; replyTo?: string }
): ContentScanResult {
	const text = stripHtml(htmlContent);
	const urls = extractUrls(htmlContent);
	const input: ScanInput = {
		subject,
		html: htmlContent,
		text,
		urls,
		from: headers?.from,
		replyTo: headers?.replyTo,
	};

	const flags: ContentFlag[] = [];
	for (const rule of contentRules.values()) {
		try {
			flags.push(...rule.scan(input));
		} catch (err) {
			// A misbehaving rule must not poison the whole scan.
			// Surface the failure via a flag so the operator can track it down.
			flags.push({
				type: 'suspicious_pattern',
				severity: 'low',
				description: `Content rule "${rule.id}" threw: ${err instanceof Error ? err.message : String(err)}`,
			});
		}
	}

	const score = calculateScore(flags);
	const level = levelForScore(score);

	return {
		score,
		pass: level === 'clean',
		flags,
		level,
	};
}

// Pluggability primitives (the public extension surface)
export { contentRules, registerContentRule, unregisterContentRule } from './rule.js';
export type { ContentScanRule, ScanInput } from './rule.js';

// Re-export sub-scanners for individual use
export { scanSpamKeywords } from './spamKeywords.js';
export { scanPhishingUrls, extractUrls, extractDomain } from './phishingUrls.js';
export { scanHomoglyphs, deconfuse } from './homoglyphs.js';
export { scanProhibitedContent } from './prohibitedContent.js';
export { scanCapsAbuse, scanExcessivePunctuation } from './subjectAnalysis.js';
export {
	scanSenderImpersonation,
	extractHeaderDomain,
	registrableDomain,
} from './senderImpersonation.js';
