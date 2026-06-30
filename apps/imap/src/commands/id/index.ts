import type { ImapCommandModule } from '../types.js';
import { syncSession } from '../helpers/session.js';

/** Max chars of client name we retain — bounds what we persist as lastUsedUa. */
const MAX_CLIENT_NAME_LEN = 120;

/**
 * Pull the `"name"` value out of an RFC 2971 ID parameter list. The line
 * parser keeps the `(...)` list as one opaque token with the inner quotes
 * intact (e.g. `("name" "Thunderbird" "version" "1.0")`), so we tokenize
 * the quoted strings here and return the value that follows a `name` key.
 * Returns null for `NIL`, an empty/odd list, or a missing `name` field.
 */
export function parseClientName(rawArgs: readonly string[]): string | null {
	const token = rawArgs[0];
	if (!token || token.toUpperCase() === 'NIL') return null;

	const strings: string[] = [];
	const re = /"((?:[^"\\]|\\.)*)"/g;
	let m: RegExpExecArray | null;
	while ((m = re.exec(token)) !== null) {
		strings.push(m[1]!.replace(/\\(.)/g, '$1'));
	}

	// Parameter list is key/value pairs; find the value after a `name` key.
	for (let i = 0; i + 1 < strings.length; i += 2) {
		if (strings[i]!.toLowerCase() === 'name') {
			const name = strings[i + 1]!.trim();
			if (!name) return null;
			return name.slice(0, MAX_CLIENT_NAME_LEN);
		}
	}
	return null;
}

/**
 * RFC 2971 ID — accept the client's identifier and echo back our own.
 *
 * The parameter list is purely informational for the protocol, but we
 * keep the client's `name` so a subsequent LOGIN can record it as the
 * app-password `lastUsedUa` (surfaced in the app-passwords admin UI).
 * Everything else in the list is ignored.
 */
export const idModule: ImapCommandModule<string | null> = {
	verbs: ['ID'],
	capabilities: ['ID'],
	parseArgs: (rawArgs) => ({ ok: true, args: parseClientName(rawArgs) }),
	start({ deps, state, args, tag, send }) {
		if (args) {
			deps.commit({ ...state, clientId: args });
		}
		send(`* ID ("name" "owlat-imap" "version" "${process.env['OWLAT_VERSION'] ?? 'dev'}")`);
		send(`${tag} OK ID completed`);
		return syncSession();
	},
};
