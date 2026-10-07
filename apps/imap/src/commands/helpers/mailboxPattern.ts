/**
 * Mailbox paths and LIST patterns as a client writes them.
 *
 * Each level of a path is decoded from modified UTF-7 on its own
 * (`mailboxNameFromClient`), so one level a client sent raw, such as `R&D`,
 * does not keep the levels around it from being decoded. A first level of
 * `INBOX` in any case is the inbox (RFC 3501 §5.1), written `INBOX` as in
 * {@link buildFolderTree}'s paths.
 *
 * LIST patterns (RFC 3501 §6.3.8) are matched against those paths: `*` matches
 * any run of characters, `%` any run without the delimiter `/`.
 */

import { mailboxNameFromClient } from './mailboxName.js';
import { DELIMITER } from './folderTree.js';

/** Fold A-Z only: no other char has a case a folder lookup may ignore. */
export const asciiLower = (s: string): string => s.replace(/[A-Z]/g, (c) => c.toLowerCase());

/** The decoded path a client's mailbox name or LIST pattern stands for. */
export function pathFromClient(wire: string): string {
	const levels = wire.split(DELIMITER).map(mailboxNameFromClient);
	if (levels.length > 0 && asciiLower(levels[0]!) === 'inbox') levels[0] = 'INBOX';
	return levels.join(DELIMITER);
}

const WILDCARD_RUN = /[*%]{2,}/g;

/** The longest reference plus mailbox pattern a LIST or LSUB may send. */
export const MAX_PATTERN_LENGTH = 1024;

/** The most `*` and `%` wildcards a LIST or LSUB pattern may hold. */
export const MAX_PATTERN_WILDCARDS = 64;

/** Why a raw LIST pattern is refused, or null when it is within the caps. */
export function patternOverLimit(raw: string): string | null {
	if (raw.length > MAX_PATTERN_LENGTH) return `pattern longer than ${MAX_PATTERN_LENGTH} chars`;
	let wildcards = 0;
	for (const ch of raw) if (ch === '*' || ch === '%') wildcards += 1;
	return wildcards > MAX_PATTERN_WILDCARDS
		? `pattern with more than ${MAX_PATTERN_WILDCARDS} wildcards`
		: null;
}

/**
 * Whether `path` matches the decoded LIST pattern `pattern`. A table over the
 * positions of `path`, one row per pattern char, so it never backtracks and
 * fills at most (pattern + 1) × (path + 1) cells. `meter`, when given, counts
 * the cells filled.
 */
export function matchesPattern(pattern: string, path: string, meter?: { cells: number }): boolean {
	// `**`, `*%` and `%*` match what `*` matches, and `%%` what `%` matches.
	const p = pattern.replace(WILDCARD_RUN, (run) => (run.includes('*') ? '*' : '%'));
	let literals = 0;
	for (const ch of p) if (ch !== '*' && ch !== '%') literals += 1;
	if (literals > path.length) return false;

	const n = path.length;
	// reach[j]: the pattern so far matches the first j chars of `path`.
	let reach = new Uint8Array(n + 1);
	reach[0] = 1;
	if (meter) meter.cells += n + 1;
	for (let k = 0; k < p.length; k++) {
		const ch = p[k];
		const next = new Uint8Array(n + 1);
		let any = 0;
		if (ch === '*') {
			for (let j = 0; j <= n; j++) {
				if (reach[j]) any = 1;
				next[j] = any;
			}
		} else if (ch === '%') {
			for (let j = 0; j <= n; j++) {
				if (j > 0 && path[j - 1] === DELIMITER) any = 0;
				if (reach[j]) any = 1;
				next[j] = any;
			}
		} else {
			for (let j = 0; j < n; j++) {
				if (reach[j] && path[j] === ch) next[j + 1] = 1;
			}
		}
		if (meter) meter.cells += n + 1;
		if (!next.includes(1)) return false;
		reach = next;
	}
	return reach[n] === 1;
}
