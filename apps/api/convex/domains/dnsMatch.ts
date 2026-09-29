/**
 * Pure TXT-record matchers for the DNS verifier (`domains/dnsVerification.ts`).
 *
 * Published DNS records rarely come back byte-for-byte identical to the value
 * we generated: nameservers and registrars normalise whitespace around the
 * `;`-separated tags (DKIM/DMARC) and may reorder or pad the space-separated
 * mechanisms (SPF). A naive `=== / .includes()` comparison therefore rejects
 * records that are semantically correct, leaving an otherwise-verified domain
 * stuck. These helpers compare the records the way the relevant RFCs define
 * equality so a cosmetic difference can't fail verification:
 *
 *   - DKIM (RFC 6376 §3.6.1) and DMARC (RFC 7489 §6.3) records are
 *     `tag=value` pairs separated by `;`. Whitespace around the separators and
 *     the `=` is insignificant, so we parse both sides into a tag→value map and
 *     require every tag we asked for to be present with the same value.
 *   - SPF (RFC 7208 §3.2) records are a `v=spf1` version token followed by
 *     space-separated terms (mechanisms/modifiers). A correct record may carry
 *     extra `include:`/`ip4:` mechanisms beyond the one we generated, so we
 *     require every term of the expected record to appear among the published
 *     record's terms rather than demanding a substring or exact match.
 *
 * Kept free of the `'use node'` runtime so it can be unit-tested as a pure
 * function without spinning up the Convex action graph. The tag-list grammar
 * and the SPF version check come from `@owlat/shared` so the checklist and the
 * DKIM verifier read a record the same way.
 */

import { parseTagList, stripTagValueWhitespace } from '@owlat/shared/dnsTagList';
import { isSpfRecord } from '@owlat/shared/spf';

/** Collapse all runs of ASCII whitespace to a single space and trim the ends. */
function collapseWhitespace(value: string): string {
	return value.replace(/\s+/g, ' ').trim();
}

/**
 * Parse a `tag=value; tag=value` record (DKIM / DMARC) with the shared
 * RFC 6376 §3.2 grammar: tag names lowercased, ALL whitespace stripped from
 * values (a DNS panel may wrap a long `p=` key, and folded whitespace is not
 * part of a key-record value), segments without `=` ignored, and the FIRST of
 * two duplicate tags wins — the same reading as the DKIM verifier in
 * `@owlat/mail-auth`.
 */
function parseRecordTags(record: string): Map<string, string> {
	return parseTagList(record, { lowercaseName: true, normalizeValue: stripTagValueWhitespace });
}

/**
 * True when `published` carries every tag/value the `expected` record asked
 * for, ignoring whitespace (around and inside values) and tag ordering. The
 * published record may carry extra tags (DKIM adds `t=`, `s=`, etc.) — those
 * don't fail the match.
 *
 * RFC 6376 §3.6.1 (DKIM) / RFC 7489 §6.3 (DMARC).
 */
export function tagValueRecordMatches(published: string, expected: string): boolean {
	const expectedTags = parseRecordTags(expected);
	if (expectedTags.size === 0) return false;
	const publishedTags = parseRecordTags(published);
	for (const [tag, value] of expectedTags) {
		if (publishedTags.get(tag) !== value) return false;
	}
	return true;
}

/**
 * Split an SPF record into its lower-cased terms (the `v=spf1` version token
 * plus the space-separated mechanisms/modifiers), normalising whitespace.
 * Returns an empty array when the record is not an SPF record
 * ({@link isSpfRecord}: `v=spf1:broken` is not one).
 *
 * RFC 7208 §3.2.
 */
export function parseSpfTerms(record: string): string[] {
	if (!isSpfRecord(record)) return [];
	return collapseWhitespace(record).toLowerCase().split(' ');
}

/**
 * True when `published` is an SPF record that contains every term of the
 * `expected` SPF record. Extra mechanisms on the published record (a domain
 * that also sends through another provider) don't fail the match.
 *
 * RFC 7208 §3.2.
 */
export function spfRecordMatches(published: string, expected: string): boolean {
	const expectedTerms = parseSpfTerms(expected);
	if (expectedTerms.length === 0) return false;
	const publishedTerms = new Set(parseSpfTerms(published));
	if (publishedTerms.size === 0) return false;
	return expectedTerms.every((term) => publishedTerms.has(term));
}

/**
 * Whitespace/tag/mechanism-aware equality for a single published TXT value
 * against the value we generated. Picks the right comparison from the
 * `expected` record's version token:
 *
 *   - `v=spf1`  → SPF mechanism containment (extra mechanisms allowed)
 *   - `v=DMARC1` / `v=DKIM1` (or any other `tag=value` record) → tag/value map
 *
 * Falls back to a whitespace-normalised exact compare for anything that isn't a
 * recognised record shape.
 */
export function txtRecordMatches(published: string, expected: string): boolean {
	if (isSpfRecord(expected)) {
		return spfRecordMatches(published, expected);
	}
	if (expected.includes('=')) {
		return tagValueRecordMatches(published, expected);
	}
	return collapseWhitespace(published) === collapseWhitespace(expected);
}
