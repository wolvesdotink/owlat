/**
 * Folder lookups shared across LIST, SELECT, STATUS, COPY, MOVE,
 * APPEND. All of them need "given a mailbox name, find the Convex folder
 * row": a path through the folder tree, with the case-insensitive `INBOX`
 * alias for the inbox.
 */

import { fn, type ConvexClient, type FolderRow } from '../../convex.js';
import { buildFolderTree, type ImapFolder } from './folderTree.js';
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
 *      read from LIST always opens that folder. Should two folders share a
 *      path, the older one has it, so a folder created later never takes over
 *      a name a client already holds.
 *   3. For a name of printable ASCII only, the one folder whose path it
 *      matches with A-Z folded, so a hand-typed `receipts` still finds
 *      `Receipts`. Before names were decoded every name was matched with its
 *      case folded; that now holds for ASCII names only, and only when one
 *      folder matches, so no fold picks between two folders.
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
	if (!PURE_ASCII.test(wanted)) return null;
	const folded = asciiLower(wanted);
	const matches = folders.filter((f) => asciiLower(f.path) === folded);
	return matches.length === 1 ? matches[0]! : null;
}
