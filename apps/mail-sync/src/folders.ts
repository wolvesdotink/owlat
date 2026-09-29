/**
 * Map a remote IMAP folder to one of Owlat's six system folder roles, using
 * SPECIAL-USE attributes (RFC 6154) first, then name heuristics for servers
 * that don't advertise them. Returns null for folders that don't map to a
 * system role (out of scope for v1 — we only sync the system folders).
 */

export type FolderRole = 'inbox' | 'sent' | 'drafts' | 'trash' | 'spam' | 'archive';

export function mapFolderRole(specialUse: string | undefined, path: string): FolderRole | null {
	switch (specialUse) {
		case '\\Inbox':
			return 'inbox';
		case '\\Sent':
			return 'sent';
		case '\\Drafts':
			return 'drafts';
		case '\\Trash':
			return 'trash';
		case '\\Junk':
			return 'spam';
		case '\\Archive':
			return 'archive';
		default:
			break;
	}

	const p = path.toLowerCase();
	if (p === 'inbox') return 'inbox';
	if (p.includes('sent')) return 'sent';
	if (p.includes('draft')) return 'drafts';
	if (p.includes('trash') || p.includes('deleted')) return 'trash';
	if (p.includes('junk') || p.includes('spam') || p.includes('bulk')) return 'spam';
	if (p.includes('archive') || p === '[gmail]/all mail') return 'archive';
	return null;
}

/**
 * SPECIAL-USE attributes of folders that are views onto mail filed elsewhere
 * (Gmail's All Mail, Starred, Important), never places of their own.
 */
const VIRTUAL_SPECIAL_USE = new Set(['\\All', '\\Flagged', '\\Important']);

/**
 * The local path a remote folder is mirrored under with full sync, or null for
 * one that is not mirrored: unselectable, INBOX itself, or a virtual view. The
 * personal namespace prefix ("INBOX." on Dovecot/Courier) is dropped, as is a
 * leading INBOX on servers that nest folders under it, so the path reads the
 * way the provider shows it.
 */
export function mirroredFolderPath(
	entry: { path: string; delimiter?: string | null; flags?: Set<string>; specialUse?: string },
	namespacePrefix: string | null | undefined
): string[] | null {
	if (entry.flags?.has('\\Noselect') || entry.flags?.has('\\NonExistent')) return null;
	if (entry.specialUse && VIRTUAL_SPECIAL_USE.has(entry.specialUse)) return null;
	if (entry.path.toUpperCase() === 'INBOX') return null;
	let path = entry.path;
	if (namespacePrefix && path.startsWith(namespacePrefix))
		path = path.slice(namespacePrefix.length);
	const segments = (entry.delimiter ? path.split(entry.delimiter) : [path]).filter(Boolean);
	if (segments.length > 1 && segments[0]?.toUpperCase() === 'INBOX') segments.shift();
	return segments.length > 0 ? segments : null;
}
