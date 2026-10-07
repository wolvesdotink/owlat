/**
 * Folder lookups shared across LIST, SELECT, STATUS, COPY, MOVE,
 * APPEND. All of them need "given a mailbox name, find the Convex folder
 * row": a path through the folder tree, with the case-insensitive `INBOX`
 * alias for the inbox.
 */

import { fn, type ConvexClient, type FolderRow } from '../../convex.js';
import { buildFolderTree, DELIMITER, type ImapFolder } from './folderTree.js';
import { asciiLower, pathFromClient } from './mailboxPattern.js';

/** Every folder of a mailbox (`mail/imap/session:listFolders`). */
export async function listFolders(convex: ConvexClient, mailboxId: string): Promise<FolderRow[]> {
	return await convex.query(fn.listFolders, { mailboxId });
}

const PURE_ASCII = /^[\x20-\x7e]*$/;

/** Every folder of a mailbox with its IMAP path (`folderTree.ts`). */
export async function listImapFolders(
	convex: ConvexClient,
	mailboxId: string
): Promise<ImapFolder[]> {
	return buildFolderTree(await listFolders(convex, mailboxId));
}

/**
 * Resolve a client-supplied mailbox name to a folder by its path, each level
 * decoded from modified UTF-7 first (`pathFromClient`). In order:
 *
 *   1. `INBOX` in any case is the folder with `role: 'inbox'` (RFC 3501
 *      §5.1), and so is a first level of `INBOX` in a longer path.
 *   2. The folder whose path is exactly the decoded name. Names are only
 *      unique as written: `Übersicht` and `übersicht` are two folders, and an
 *      encoded run is case-sensitive (RFC 3501 §5.1.3), so the name a client
 *      read from LIST always opens that folder. No two folders share a path
 *      (`folderTree.ts`), so this is that folder or none.
 *   3. The one folder whose path matches level by level, each level of
 *      printable ASCII with A-Z folded and every other level exactly, so a
 *      hand-typed `receipts` still finds `Receipts`, and `Übersicht/receipts`
 *      finds `Übersicht/Receipts`. Before names were decoded every name was
 *      matched with its case folded; that now holds for ASCII levels only, and
 *      only when one folder matches, so no fold picks between two folders. A
 *      first level of `INBOX` stays the inbox here too, never a folder whose
 *      own name only folds to it. Such a folder is reached in step 2 by the
 *      name LIST gives it, its name with its id (`topLevelName`).
 *
 * Returns null when nothing matches.
 */
export async function resolveFolderByName(
	convex: ConvexClient,
	mailboxId: string,
	name: string
): Promise<ImapFolder | null> {
	const folders = await listImapFolders(convex, mailboxId);
	const wanted = pathFromClient(name);
	if (wanted === 'INBOX') {
		const inbox = folders.find((f) => f.role === 'inbox');
		if (inbox) return inbox;
	}
	const exact = folders.find((f) => f.path === wanted);
	if (exact) return exact;

	const levels = wanted.split(DELIMITER);
	const folds = levels.map((level, i) =>
		PURE_ASCII.test(level) && !(i === 0 && level === 'INBOX') ? asciiLower(level) : null
	);
	if (!folds.some((fold) => fold !== null)) return null;
	const matches = folders.filter((f) => {
		const own = f.path.split(DELIMITER);
		return (
			own.length === levels.length &&
			own.every((level, i) => {
				const fold = folds[i];
				return fold === null ? level === levels[i] : asciiLower(level) === fold;
			})
		);
	});
	return matches.length === 1 ? matches[0]! : null;
}
