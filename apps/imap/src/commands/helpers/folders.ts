/**
 * Folder lookups shared across LIST, SELECT, STATUS, COPY, MOVE,
 * APPEND. All of them need "given a mailbox-name string, find the
 * Convex folder row" — including the case-insensitive `INBOX` alias
 * fallback to the role.
 */

import { fn, type ConvexClient, type FolderRow } from '../../convex.js';
import { mailboxNameFromClient } from './mailboxName.js';

/** Every folder of a mailbox (`mail/imap/session:listFolders`). */
export async function listFolders(convex: ConvexClient, mailboxId: string): Promise<FolderRow[]> {
	return await convex.query(fn.listFolders, { mailboxId });
}

/** Fold A-Z only: no other char has a case a folder lookup may ignore. */
const asciiLower = (s: string): string => s.replace(/[A-Z]/g, (c) => c.toLowerCase());

const PURE_ASCII = /^[\x20-\x7e]*$/;

/**
 * Resolve a client-supplied mailbox name, decoded from modified UTF-7 first
 * (see `mailboxNameFromClient`). In order:
 *
 *   1. `INBOX` in any case is the folder with `role: 'inbox'` (RFC 3501
 *      §5.1).
 *   2. A folder whose name is exactly the decoded name. Folder names are
 *      only unique as written: `Übersicht` and `übersicht` are two folders,
 *      and an encoded run is case-sensitive (RFC 3501 §5.1.3), so the name a
 *      client read from LIST always opens that folder.
 *   3. For a name of printable ASCII only, the one folder it matches with
 *      A-Z folded, so a hand-typed `receipts` still finds `Receipts`. Before
 *      names were decoded every name was matched with its case folded; that
 *      now holds for ASCII names only, and only when one folder matches, so
 *      no fold picks between two folders.
 *
 * Returns null when nothing matches.
 */
export async function resolveFolderByName(
	convex: ConvexClient,
	mailboxId: string,
	name: string
): Promise<FolderRow | null> {
	const folders = await listFolders(convex, mailboxId);
	const wanted = mailboxNameFromClient(name);
	const folded = asciiLower(wanted);
	if (folded === 'inbox') {
		const inbox = folders.find((f) => f.role === 'inbox');
		if (inbox) return inbox;
	}
	const exact = folders.find((f) => f.name === wanted);
	if (exact) return exact;
	if (!PURE_ASCII.test(wanted)) return null;
	const matches = folders.filter((f) => asciiLower(f.name) === folded);
	return matches.length === 1 ? matches[0]! : null;
}
