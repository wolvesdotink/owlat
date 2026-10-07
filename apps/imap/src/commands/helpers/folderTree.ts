/**
 * The folder hierarchy as IMAP clients see it. Folders nest through
 * `parentId`; a folder's IMAP name is its path, the names of its ancestors and
 * its own joined with the hierarchy delimiter `/`, outermost first.
 *
 * A path depends only on the folder's own name and ancestors, so it changes
 * only when one of those is renamed or moved, never because another folder
 * appeared. Two rules keep it that way:
 *
 *   - The inbox is always the top-level `INBOX` (RFC 3501 §5.1).
 *   - A `/` inside one folder's own name would read as a hierarchy level, so it
 *     is sent as U+2215 DIVISION SLASH `∕`, which looks the same. New names
 *     cannot hold a `/` (`mail/folders.ts`); this covers older names and names
 *     mirrored from a provider whose delimiter is not `/`.
 *
 * A folder whose parent is missing (deleted, or in another mailbox) is listed
 * at the top level, as the web app shows it.
 */

import type { FolderRow } from '../../convex.js';

/** The hierarchy delimiter, also the one LIST and NAMESPACE announce. */
export const DELIMITER = '/';

/** What a `/` inside a single folder name is sent as. */
const NAME_SLASH = '∕';

/** A folder with its IMAP path and whether any folder sits below it. */
export interface ImapFolder extends FolderRow {
	readonly path: string;
	readonly hasChildren: boolean;
}

/** The one level of a path a folder contributes. */
function levelName(folder: FolderRow): string {
	if (folder.role === 'inbox') return 'INBOX';
	return folder.name.split(DELIMITER).join(NAME_SLASH);
}

/**
 * Every folder with its path, in the order given. Listing order is the
 * backend's (oldest first), so where two folders share a path the older one
 * comes first and keeps the name (see `resolveFolderByName`).
 */
export function buildFolderTree(folders: readonly FolderRow[]): ImapFolder[] {
	const byId = new Map(folders.map((f) => [f._id, f]));
	const parentOf = (f: FolderRow): FolderRow | undefined =>
		f.role === 'inbox' || !f.parentId ? undefined : byId.get(f.parentId);

	const paths = new Map<string, string>();
	const pathOf = (folder: FolderRow): string => {
		const known = paths.get(folder._id);
		if (known !== undefined) return known;
		// Walk up to the top, stopping at a missing parent or a loop.
		const chain: FolderRow[] = [];
		const seen = new Set<string>();
		for (let f: FolderRow | undefined = folder; f && !seen.has(f._id); f = parentOf(f)) {
			seen.add(f._id);
			chain.push(f);
		}
		const path = chain.reverse().map(levelName).join(DELIMITER);
		paths.set(folder._id, path);
		return path;
	};

	const withChildren = new Set<string>();
	for (const f of folders) {
		const parent = parentOf(f);
		if (parent) withChildren.add(parent._id);
	}
	return folders.map((f) => ({ ...f, path: pathOf(f), hasChildren: withChildren.has(f._id) }));
}
