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

/**
 * Whether `path` matches the decoded LIST pattern `pattern`. A table over the
 * positions of `path`, one pattern char at a time, so a pattern with many
 * wildcards costs at most pattern × path steps and never backtracks.
 */
export function matchesPattern(pattern: string, path: string): boolean {
	// `**`, `*%` and `%*` match what `*` matches, and `%%` what `%` matches.
	const p = pattern.replace(WILDCARD_RUN, (run) => (run.includes('*') ? '*' : '%'));
	let literals = 0;
	for (const ch of p) if (ch !== '*' && ch !== '%') literals += 1;
	if (literals > path.length) return false;

	const n = path.length;
	// reach[j]: the pattern so far matches the first j chars of `path`.
	let reach = new Uint8Array(n + 1);
	reach[0] = 1;
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
		if (!next.includes(1)) return false;
		reach = next;
	}
	return reach[n] === 1;
}
