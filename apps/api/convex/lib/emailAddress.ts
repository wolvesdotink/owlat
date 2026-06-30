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

/**
 * Normalize an email subject for thread matching.
 * Strips Re:/Fwd:/FW: prefixes and normalizes whitespace.
 */
export function normalizeSubject(subject: string): string {
	return subject
		.replace(/^(re|fwd|fw)\s*:\s*/gi, '')
		.replace(/^(re|fwd|fw)\s*:\s*/gi, '') // Handle nested prefixes
		.trim()
		.toLowerCase();
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
