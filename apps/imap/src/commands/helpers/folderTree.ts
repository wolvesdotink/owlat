/**
 * The folder hierarchy as IMAP clients see it. Folders nest through
 * `parentId`; a folder's IMAP name is its path, the names of its ancestors and
 * its own joined with the hierarchy delimiter `/`, outermost first.
 *
 * Each level is a function of one folder's stored name and nothing else (see
 * {@link levelName}), and that function is injective. The one exception is a
 * top-level folder named `INBOX` in some case, whose level also holds its own
 * id and is never a level {@link levelName} writes ({@link topLevelName}).
 * Stored names are unique per mailbox (`mail/folders.ts`), so no two folders
 * share a path, and a path changes only when the folder or one of its
 * ancestors is renamed or moved, never because another folder was created,
 * renamed or deleted.
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
 * wildcard `*` or `%` the name did not have. Introducing it changed, once, the
 * IMAP name of a folder already holding `∕` or `⧵` (see "IMAP folder names and
 * hierarchy" in the self-hosting maintenance docs).
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

/** `INBOX` in any case, ASCII only: without the `u` flag no non-ASCII char matches `i`. */
const INBOX_ANY_CASE = /^inbox$/i;

/** What a folder id must look like to go into a name. Convex ids are lowercase base32. */
const NAME_SAFE_ID = /^[0-9A-Za-z_-]+$/;

/**
 * The level a folder contributes at the top of its path. That is
 * {@link levelName}, except for a folder other than the inbox whose name is
 * `INBOX` in some case, such as `Inbox`. RFC 3501 §5.1 reads `INBOX` in any
 * case as the inbox, so under its own name that folder could never be opened.
 * New names cannot be one (`mail/folders.ts`); older ones and folders
 * mirrored from a provider can. Such a folder is listed as its name, a `⧵`
 * and its id: `Inbox⧵k57c…`.
 *
 * No stored name is ever written that way. Read code word by code word, a
 * `⧵` in {@link levelName}'s output is always followed by `⧵` or `∕`, and an
 * id starts with neither. Ids are unique, so no two folders share one. It
 * depends on the folder's own name and id only, so creating, renaming or
 * deleting another folder never moves it, and renaming the folder itself to
 * any other name gives it back an ordinary one. A folder called `Inbox` below
 * another keeps its name: only a first level reads as the inbox.
 */
export function topLevelName(folder: FolderRow): string {
	const level = levelName(folder);
	return folder.role !== 'inbox' &&
		INBOX_ANY_CASE.test(folder.name) &&
		NAME_SAFE_ID.test(folder._id)
		? level + NAME_ESCAPE + folder._id
		: level;
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
		return chain
			.reverse()
			.map((f, i) => (i === 0 ? topLevelName(f) : levelName(f)))
			.join(DELIMITER);
	};

	const withChildren = new Set<string>();
	for (const f of folders) {
		const parent = parentOf(f);
		if (parent) withChildren.add(parent._id);
	}
	return folders.map((f) => ({ ...f, path: pathOf(f), hasChildren: withChildren.has(f._id) }));
}
