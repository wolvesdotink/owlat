/**
 * The folder hierarchy as IMAP clients see it. Folders nest through
 * `parentId`; a folder's IMAP name is its path, the names of its ancestors and
 * its own joined with the hierarchy delimiter `/`, outermost first.
 *
 * Each level is a function of one folder's stored name and nothing else (see
 * {@link levelName}), and that function is injective. Stored names are unique
 * per mailbox (`mail/folders.ts`), so no two folders share a path, and a path
 * changes only when the folder or one of its ancestors is renamed or moved,
 * never because another folder was created, renamed or deleted.
 *
 * A folder whose parent is missing (deleted, or in another mailbox) is listed
 * at the top level, as the web app shows it.
 */

import type { FolderRow } from '../../convex.js';

/** The hierarchy delimiter, also the one LIST and NAMESPACE announce. */
export const DELIMITER = '/';

/** A folder with its IMAP path and whether any folder sits below it. */
export interface ImapFolder extends FolderRow {
	readonly path: string;
	readonly hasChildren: boolean;
}

/** What a `/` inside one folder's name is sent as: U+2215 DIVISION SLASH. */
const NAME_SLASH = '\u2215';

/** Escapes a literal {@link NAME_SLASH} or itself: U+29F5 REVERSE SOLIDUS OPERATOR. */
const NAME_ESCAPE = '\u29f5';

/**
 * The one level of a path a folder contributes. The inbox is always `INBOX`
 * (RFC 3501 §5.1). No other folder is stored as `INBOX`: names are unique per
 * mailbox and the inbox holds that one. For every other folder, its stored
 * name with:
 *
 *   - `/` sent as `∕`, since a `/` would read as a level of nesting. New names
 *     cannot hold one (`mail/folders.ts`); older names and names mirrored
 *     from a provider whose delimiter is not `/` can.
 *   - a literal `∕` sent as `⧵∕`, and a literal `⧵` as `⧵⧵`, so that a stored
 *     `A/B` and a stored `A∕B` stay two names.
 *
 * Every other char stands for itself. No code word is a prefix of another
 * (`⧵` alone is none, and each two-char one starts with `⧵`), so the result
 * reads back one way only and two names never meet. It holds no `/` and no
 * wildcard `*` or `%` the name did not have.
 */
export function levelName(folder: FolderRow): string {
	if (folder.role === 'inbox') return 'INBOX';
	let out = '';
	for (const ch of folder.name) {
		if (ch === DELIMITER) out += NAME_SLASH;
		else if (ch === NAME_SLASH || ch === NAME_ESCAPE) out += NAME_ESCAPE + ch;
		else out += ch;
	}
	return out;
}

/** Every folder with its path and whether any folder sits below it, in the order given. */
export function buildFolderTree(folders: readonly FolderRow[]): ImapFolder[] {
	const byId = new Map(folders.map((f) => [f._id, f]));
	const parentOf = (f: FolderRow): FolderRow | undefined =>
		f.role === 'inbox' || !f.parentId ? undefined : byId.get(f.parentId);

	const pathOf = (folder: FolderRow): string => {
		// Walk up to the top, stopping at a missing parent or a loop.
		const chain: FolderRow[] = [];
		const seen = new Set<string>();
		for (let f: FolderRow | undefined = folder; f && !seen.has(f._id); f = parentOf(f)) {
			seen.add(f._id);
			chain.push(f);
		}
		return chain.reverse().map(levelName).join(DELIMITER);
	};

	const withChildren = new Set<string>();
	for (const f of folders) {
		const parent = parentOf(f);
		if (parent) withChildren.add(parent._id);
	}
	return folders.map((f) => ({ ...f, path: pathOf(f), hasChildren: withChildren.has(f._id) }));
}
