/**
 * Pluggable content scan rule contract.
 *
 * Each rule is a pure function over a ScanInput that returns ContentFlag[].
 * Built-in rules (spamKeywords, phishingUrls, homoglyphs, subjectAnalysis,
 * prohibitedContent) register themselves at module load. Third parties can
 * register additional rules via registerContentRule() from the package
 * entry without forking the scanner.
 */

import { createRegistry } from '@owlat/shared/registry';
import type { ContentFlag } from '../types.js';

/**
 * Pre-processed inputs handed to every rule by scanContent().
 *
 * Pre-computing once means rules can share work (e.g. URL extraction)
 * without each rule reparsing the HTML.
 */
export interface ScanInput {
	/** Raw subject line. */
	subject: string;
	/** Raw HTML body. */
	html: string;
	/** HTML body with tags stripped and entities decoded — for keyword scanning. */
	text: string;
	/** URLs extracted from the HTML once, reused by URL-aware rules. */
	urls: Array<{ href: string; text: string }>;
	/**
	 * Raw `From:` header value (address or "Name <address>"). Optional — the
	 * legacy scanContent(subject, html) callers pass no headers, so header-aware
	 * rules (sender-impersonation) must no-op when it is absent rather than
	 * assume a sender. Header rules stay content-only: they inspect the strings
	 * handed to them and never reach for the network or a database.
	 */
	from?: string;
	/** Raw `Reply-To:` header value, when present. Optional, as above. */
	replyTo?: string;
}

/**
 * A pluggable content scan rule. Pure, synchronous, no I/O.
 */
export interface ContentScanRule {
	/** Stable kebab-case identifier (e.g. 'spam-keywords'). */
	id: string;
	/** Returns the flags raised by this rule. Empty array = clean. */
	scan(input: ScanInput): ContentFlag[];
}

/**
 * Registry of installed content scan rules.
 *
 * Iteration order follows registration order; built-in rules register in the
 * historical order to preserve flag-ordering behavior of scanContent().
 */
export const contentRules = createRegistry<string, ContentScanRule>('contentRules');

/**
 * Register a content scan rule. Replaces any prior rule with the same id.
 *
 * Throws if the contentRules registry has been finalized.
 */
export function registerContentRule(rule: ContentScanRule): void {
	contentRules.register(rule.id, rule);
}

/**
 * Unregister a content scan rule by id. Returns true if a rule was removed.
 *
 * Throws if the contentRules registry has been finalized.
 */
export function unregisterContentRule(id: string): boolean {
	return contentRules.unregister(id);
}
