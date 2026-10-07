/**
 * Folder-role → IMAP flag string mapping used by LIST, LSUB, and
 * (eventually) any folder-listing surface.
 *
 * The flag set encodes IMAP's special-use designators (RFC 6154):
 * `\Sent`, `\Drafts`, `\Trash`, `\Junk`, `\Archive`. Every folder also
 * gets `\HasChildren` or `\HasNoChildren` (RFC 3348) from the folder tree.
 */

const SPECIAL_USE: Record<string, readonly string[]> = {
	inbox: [],
	sent: ['\\Sent'],
	drafts: ['\\Drafts'],
	trash: ['\\Trash'],
	spam: ['\\Junk'],
	archive: ['\\Archive'],
};

export function flagsForFolder(role: string | undefined, hasChildren: boolean): string {
	const extra = role ? (SPECIAL_USE[role] ?? []) : [];
	return [...extra, hasChildren ? '\\HasChildren' : '\\HasNoChildren'].join(' ');
}
