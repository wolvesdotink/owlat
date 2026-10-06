/**
 * Folder lookups shared across LIST, SELECT, STATUS, COPY, MOVE,
 * APPEND. All of them need "given a mailbox-name string, find the
 * Convex folder row" — including the case-insensitive `INBOX` alias
 * fallback to the role.
 */

import { fn, type ConvexClient, type FolderRow } from '../../convex.js';
import { mailboxNameFromClient } from './mailboxName.js';

/**
 * Every folder of a mailbox (`mail/imap/session:listFolders`), each under the
 * name IMAP clients know it by (see {@link withImapNames}). LIST, STATUS and
 * the name lookup all read these rows, so a client opens a folder under the
 * name LIST gave it.
 */
export async function listFolders(convex: ConvexClient, mailboxId: string): Promise<FolderRow[]> {
	return withImapNames(await convex.query(fn.listFolders, { mailboxId }));
}

/** Fold A-Z only: no other char has a case a folder lookup may ignore. */
const asciiLower = (s: string): string => s.replace(/[A-Z]/g, (c) => c.toLowerCase());

/**
 * The folders under their IMAP names: each its own name, except a folder
 * other than the inbox whose name is `INBOX` in some case, such as an `Inbox`
 * mirrored from a provider. `INBOX` in any case means the inbox (RFC 3501
 * §5.1), so that folder could not be opened under its own name; it goes by
 * `<name> (2)`, or the next number no folder holds, like the numbered
 * variants mirrored folders get. The backend returns the folders in creation
 * order, so every session numbers them alike. Postbox no longer lets anyone
 * create or rename a folder to such a name (`mail/folders.ts`).
 */
export function withImapNames(folders: FolderRow[]): FolderRow[] {
	if (!folders.some((f) => f.role === 'inbox')) return folders;
	const taken = new Set(folders.map((f) => f.name));
	return folders.map((f) => {
		if (f.role === 'inbox' || asciiLower(f.name) !== 'inbox') return f;
		let n = 2;
		while (taken.has(`${f.name} (${n})`)) n += 1;
		const name = `${f.name} (${n})`;
		taken.add(name);
		return { ...f, name };
	});
}

const PURE_ASCII = /^[\x20-\x7e]*$/;

/**
 * Resolve a client-supplied mailbox name, decoded from modified UTF-7 first
 * (see `mailboxNameFromClient`). In order:
 *
 *   1. `INBOX` in any case is the folder with `role: 'inbox'` (RFC 3501
 *      §5.1). Another folder named so is listed under a numbered name
 *      ({@link withImapNames}) and found by that.
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
