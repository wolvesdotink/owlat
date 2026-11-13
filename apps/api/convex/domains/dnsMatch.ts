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
 *     the `=` is insignificant, so we parse both sides into a tag→value map.
 *     DKIM requires every tag we asked for with the same value. DMARC accepts
 *     a published policy at least as strict as the generated one and a report
 *     URI list that contains ours ({@link dmarcRecordMatches}).
 *   - SPF (RFC 7208 §3.2) records are a `v=spf1` version token followed by
 *     space-separated terms (mechanisms/modifiers). A correct record may carry
 *     extra `include:`/`ip4:` mechanisms beyond the one we generated, so we
 *     require every mechanism of the expected record to appear among the
 *     published record's terms, and judge the terminal `all` by strictness
 *     rather than spelling ({@link spfRecordMatches}).
 *
 * Kept free of the `'use node'` runtime so it can be unit-tested as a pure
 * function without spinning up the Convex action graph. The tag-list grammar
 * and the SPF version check come from `@owlat/shared` so the checklist and the
 * DKIM verifier read a record the same way.
 */

import { normalizeDmarcReportAddress } from '@owlat/shared/dmarcReportAddress';
import { parseTagList, stripTagValueWhitespace } from '@owlat/shared/dnsTagList';
import { isSpfRecord, mergeSpfRecords } from '@owlat/shared/spf';
import { isDmarcRecord } from './dmarc';
import { detectMultipleSpf } from './spf';

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

const SPF_ALL_TERM_RE = /^([+?~-]?)all$/;

/**
 * How firmly an `all` term turns away everyone the record did not list
 * (RFC 7208 §4.6.2, §5.1): `+all` (also bare `all`) passes them, `?all` is
 * neutral, `~all` soft-fails, `-all` fails. `null` for any other term.
 */
function spfAllStrictness(term: string): number | null {
	const match = SPF_ALL_TERM_RE.exec(term);
	if (!match) return null;
	switch (match[1]) {
		case '-':
			return 3;
		case '~':
			return 2;
		case '?':
			return 1;
		default:
			return 0;
	}
}

/**
 * The weakest terminal policy that verifies. `+all` authorises every host on
 * the internet and `?all` asserts nothing, so a record carrying either term
 * gives receivers no way to tell our mail from a forgery, whatever else it
 * lists.
 */
const SPF_MIN_VERIFIABLE_ALL_STRICTNESS = 2;

/**
 * True when `published` is an SPF record that authorises everything the
 * `expected` record authorises, with a terminal policy at least as strict:
 *
 *   - every expected term other than its `all` (mechanisms and modifiers,
 *     `redirect=` included, compared literally) appears in the published
 *     record before its first `all`. Receivers stop at that `all`
 *     (RFC 7208 §4.6.2), so a mechanism after it authorises nothing. Extra
 *     mechanisms (a domain that also sends through another provider) are fine;
 *   - when the expected record ends in an `all`, the published one has an
 *     `all` at least as strict: `-all` satisfies a generated `~all`, a
 *     generated `-all` needs `-all`;
 *   - a published `+all`, bare `all` or `?all` term anywhere never verifies.
 *
 * The Domains verifier and the deliverability checklist both judge SPF with
 * this one function; the checklist adds its own `-all` requirement on top.
 */
export function spfRecordMatches(published: string, expected: string): boolean {
	const expectedTerms = parseSpfTerms(expected);
	if (expectedTerms.length === 0) return false;
	const publishedTerms = parseSpfTerms(published);
	if (publishedTerms.length === 0) return false;

	const publishedAll = publishedTerms.map(spfAllStrictness);
	if (
		publishedAll.some(
			(strictness) => strictness !== null && strictness < SPF_MIN_VERIFIABLE_ALL_STRICTNESS
		)
	) {
		return false;
	}
	const allIndex = publishedAll.findIndex((strictness) => strictness !== null);
	const evaluatedTerms = new Set(
		allIndex === -1 ? publishedTerms : publishedTerms.slice(0, allIndex)
	);

	let expectedAll: number | null = null;
	for (const term of expectedTerms) {
		const strictness = spfAllStrictness(term);
		if (strictness !== null) {
			expectedAll ??= strictness;
			continue;
		}
		if (!evaluatedTerms.has(term)) return false;
	}
	if (expectedAll === null) return true;
	const effectiveAll = allIndex === -1 ? null : (publishedAll[allIndex] ?? null);
	return effectiveAll !== null && effectiveAll >= expectedAll;
}

const DMARC_POLICY_STRICTNESS: Readonly<Record<string, number>> = {
	none: 0,
	quarantine: 1,
	reject: 2,
};

const DMARC_ALIGNMENT_STRICTNESS: Readonly<Record<string, number>> = { r: 0, s: 1 };

/** Ordered comparison of two tag values on a strictness scale; unknown values never match. */
function isAtLeastAsStrict(
	scale: Readonly<Record<string, number>>,
	published: string | undefined,
	expected: string
): boolean {
	const publishedRank = published === undefined ? undefined : scale[published.toLowerCase()];
	const expectedRank = scale[expected.toLowerCase()];
	return publishedRank !== undefined && expectedRank !== undefined && publishedRank >= expectedRank;
}

/** One reporting URI, folded so `mailto:A@x!10m` and `mailto:a@x` compare equal. */
function normalizeDmarcReportUri(uri: string): string {
	return normalizeDmarcReportAddress(uri) ?? uri.trim().toLowerCase();
}

function dmarcReportUris(value: string | undefined): Set<string> {
	return new Set(
		(value ?? '')
			.split(',')
			.filter((uri) => uri.trim() !== '')
			.map(normalizeDmarcReportUri)
	);
}

function dmarcTagSatisfied(
	tag: string,
	expectedValue: string,
	publishedTags: ReadonlyMap<string, string>
): boolean {
	const published = publishedTags.get(tag);
	switch (tag) {
		case 'p':
			return isAtLeastAsStrict(DMARC_POLICY_STRICTNESS, published, expectedValue);
		// An absent `sp=` means subdomains take `p=` (RFC 7489 §6.3).
		case 'sp':
			return isAtLeastAsStrict(
				DMARC_POLICY_STRICTNESS,
				published ?? publishedTags.get('p'),
				expectedValue
			);
		// Absent alignment tags mean relaxed (RFC 7489 §6.3).
		case 'adkim':
		case 'aspf':
			return isAtLeastAsStrict(DMARC_ALIGNMENT_STRICTNESS, published ?? 'r', expectedValue);
		// An absent `pct=` applies the policy to all mail (RFC 7489 §6.3).
		case 'pct': {
			const publishedPct = Number(published ?? '100');
			const expectedPct = Number(expectedValue);
			return (
				Number.isInteger(publishedPct) &&
				Number.isInteger(expectedPct) &&
				publishedPct >= expectedPct
			);
		}
		// The operator may send reports to more recipients than ours.
		case 'rua':
		case 'ruf': {
			const publishedUris = dmarcReportUris(published);
			const expectedUris = dmarcReportUris(expectedValue);
			return expectedUris.size > 0 && [...expectedUris].every((uri) => publishedUris.has(uri));
		}
		default:
			return published === expectedValue;
	}
}

/**
 * True when `published` is a DMARC record that asks receivers for at least
 * what the `expected` record asks for: a policy (`p=`, and `sp=` when we
 * generated one) at least as strict on none < quarantine < reject, alignment
 * and `pct=` at least as strict, every `rua=`/`ruf=` recipient of ours among
 * the published ones. Any other tag must carry the same value. Tag order,
 * whitespace and extra tags don't matter.
 *
 * RFC 7489 §6.3. Two DMARC records at one name are the caller's check:
 * receivers then apply no policy at all (RFC 7489 §6.6.3).
 */
export function dmarcRecordMatches(published: string, expected: string): boolean {
	if (!isDmarcRecord(published)) return false;
	const expectedTags = parseRecordTags(expected);
	if (expectedTags.size === 0) return false;
	const publishedTags = parseRecordTags(published);
	// A tag our record leaves out still asks for its RFC 7489 §6.3 default, so
	// `p=reject` alone rules out a published `sp=none` or `pct=0`.
	const expectedP = expectedTags.get('p');
	const effectiveExpected = new Map([
		...(expectedP === undefined ? [] : [['sp', expectedP] as const]),
		['pct', '100'],
		...expectedTags,
	]);
	for (const [tag, value] of effectiveExpected) {
		if (tag === 'v') continue;
		if (!dmarcTagSatisfied(tag, value, publishedTags)) return false;
	}
	return true;
}

/**
 * Whitespace/tag/mechanism-aware equality for a single published TXT value
 * against the value we generated. Picks the right comparison from the
 * `expected` record's version token:
 *
 *   - `v=spf1`  → SPF mechanism containment (extra mechanisms allowed)
 *   - `v=DMARC1` → DMARC policy at least as strict
 *   - `v=DKIM1` (or any other `tag=value` record) → tag/value map
 *
 * Falls back to a whitespace-normalised exact compare for anything that isn't a
 * recognised record shape.
 */
export function txtRecordMatches(published: string, expected: string): boolean {
	if (isSpfRecord(expected)) {
		return spfRecordMatches(published, expected);
	}
	if (isDmarcRecord(expected)) {
		return dmarcRecordMatches(published, expected);
	}
	if (expected.includes('=')) {
		return tagValueRecordMatches(published, expected);
	}
	return collapseWhitespace(published) === collapseWhitespace(expected);
}

/**
 * The failure for a policy record published more than once at one name, or
 * `null` when the name carries at most one. A duplicate fails even when one
 * copy matches `expected`, because receivers stop evaluating:
 *
 *   - two `v=spf1` records are a PermError (RFC 7208 §3.2). When the other
 *     record is a foreign one (a domain that already sends through another
 *     provider), the error offers the single merged record to publish instead.
 *   - two `v=DMARC1` records mean no DMARC policy is applied (RFC 7489 §6.6.3).
 */
export function duplicatePolicyRecordFailure(
	txtValues: readonly string[],
	expected: string
): { error: string; foundValue: string } | null {
	if (isSpfRecord(expected) && detectMultipleSpf(txtValues)) {
		const spfRecords = txtValues.filter((value) => isSpfRecord(value));
		const foreign = spfRecords.find((value) => value.trim() !== expected.trim());
		const mergeHint = foreign
			? ` Merge them into a single record: "${mergeSpfRecords(foreign, expected)}".`
			: '';
		return {
			error:
				'Multiple v=spf1 records found at this hostname (duplicate SPF). ' +
				'Only one SPF record is allowed — merge them into a single record ' +
				`(RFC 7208 §3.2 PermError).${mergeHint}`,
			foundValue: spfRecords.join(' | '),
		};
	}
	if (isDmarcRecord(expected)) {
		const dmarcRecords = txtValues.filter((value) => isDmarcRecord(value));
		if (dmarcRecords.length > 1) {
			return {
				error:
					'Multiple v=DMARC1 records found at this hostname. Receivers then apply no DMARC ' +
					'policy (RFC 7489 §6.6.3) — merge them into a single record.',
				foundValue: dmarcRecords.join(' | '),
			};
		}
	}
	return null;
}
