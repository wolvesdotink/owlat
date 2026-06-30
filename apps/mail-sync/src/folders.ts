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
