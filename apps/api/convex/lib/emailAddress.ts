/**
 * Shared email-address + subject helpers used across the inbound/threading paths.
 *
 * `normalizeSubject` feeds `mailThreads.normalizedSubject` under the
 * `by_mailbox_and_subject` index, so every call site MUST produce identical
 * output or conversation threading breaks. Keep this the single source of truth.
 *
 * Address parsing lives in `@owlat/shared` (`parseAddress` / `normalizeEmail`)
 * so the Convex backend, the MTA, and IMAP all agree on what a sender address
 * is. `extractEmail` is a thin wrapper that keeps the historical call-site name
 * while delegating to the shared parser.
 */

import { normalizeEmail, parseAddress } from '@owlat/shared';

// One leading reply/forward marker: the English `Re:` / `Fwd:` / `Fw:` plus the
// common localized forms (German AW/WG, Scandinavian SV, Finnish VS, Dutch
// Antw, Polish Odp), optionally counted as Outlook does (`Re[2]:`, `AW(3):`).
const SUBJECT_PREFIX = /^\s*(re|fwd|fw|aw|wg|sv|vs|antw|odp)\s*(?:\[\d+\]|\(\d+\))?\s*:\s*/i;

// The subset of those markers that mean "this is a reply" (forwards are not).
const REPLY_PREFIXES = new Set(['re', 'aw', 'sv', 'vs', 'antw', 'odp']);

/**
 * Normalize an email subject for thread matching.
 * Strips any depth of reply/forward prefixes (including localized ones) and
 * normalizes whitespace + case.
 */
export function normalizeSubject(subject: string): string {
	let rest = subject;
	for (let match = SUBJECT_PREFIX.exec(rest); match; match = SUBJECT_PREFIX.exec(rest)) {
		rest = rest.slice(match[0].length);
	}
	return rest.trim().toLowerCase();
}

/**
 * True when the subject opens with a reply marker (`Re:`, `AW:`, `SV:` …).
 * A forward marker alone does not count: a forward starts a new conversation.
 */
export function hasReplyPrefix(subject: string): boolean {
	const match = SUBJECT_PREFIX.exec(subject);
	return match !== null && REPLY_PREFIXES.has(match[1]!.toLowerCase());
}

/**
 * Extract the bare email address from a "Name <email>" / bare-address string,
 * lowercased. Feeds inbound sender resolution + thread matching, so it MUST
 * stay byte-for-byte consistent with every other address derivation — hence it
 * routes through the shared `parseAddress`. Falls back to `normalizeEmail` (a
 * lowercased trim) when nothing address-shaped is present, preserving the
 * historical "return the input lowercased" behavior for non-addresses.
 */
export function extractEmail(fromField: string): string {
	return parseAddress(fromField)?.address ?? normalizeEmail(fromField);
}

/**
 * Build a reply subject by prefixing "Re: " unless the subject already starts
 * with one (case-insensitively). Avoids the "Re: RE: …" double-prefix bug from
 * a case-sensitive check.
 */
export function buildReplySubject(subject?: string): string {
	const s = subject ?? '';
	return s.toLowerCase().startsWith('re:') ? s : `Re: ${s}`;
}
