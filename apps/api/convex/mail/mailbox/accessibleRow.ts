/**
 * The per-mailbox reads behind `queries.accessible`: each system folder by
 * role, and what a connected mailbox's account says about its provider.
 *
 * Not a Convex function; a helper for `queries.ts`.
 */

import type { Doc, Id } from '../../_generated/dataModel';
import type { QueryCtx } from '../../_generated/server';
import { SYSTEM_FOLDER_ROLES, type FolderRole } from '../../lib/validators/mail';

/** A connected account's provider, for the logo its inbox chip can show. */
export type InboxProvider = 'gmail' | 'microsoft';

// A provider sign-in names its provider; an app-password account is known by
// the IMAP host its provider publishes.
const GMAIL_IMAP_HOSTS = new Set(['imap.gmail.com']);
const MICROSOFT_IMAP_HOSTS = new Set(['outlook.office365.com', 'imap-mail.outlook.com']);

export function providerOf(account: Doc<'externalMailAccounts'> | null): InboxProvider | null {
	if (!account) return null;
	if (account.oauthProvider === 'google') return 'gmail';
	if (account.oauthProvider === 'microsoft') return 'microsoft';
	const host = account.imapHost.trim().toLowerCase();
	if (GMAIL_IMAP_HOSTS.has(host)) return 'gmail';
	if (MICROSOFT_IMAP_HOSTS.has(host)) return 'microsoft';
	return null;
}

/**
 * The IMAP host a connected mailbox syncs from, lowercased: what the unified
 * folders narrow by provider on. Null for a hosted mailbox.
 */
export function providerHostOf(account: Doc<'externalMailAccounts'> | null): string | null {
	return account ? account.imapHost.trim().toLowerCase() : null;
}

/**
 * Each system folder of a mailbox by role (null where it has none), and the
 * Inbox's denormalized unread count. Six index reads, one per role.
 */
export async function readRoleFolders(
	ctx: QueryCtx,
	mailboxId: Id<'mailboxes'>
): Promise<{ folderIds: Record<FolderRole, Id<'mailFolders'> | null>; inboxUnread: number }> {
	const folderIds = {} as Record<FolderRole, Id<'mailFolders'> | null>;
	let inboxUnread = 0;
	for (const role of SYSTEM_FOLDER_ROLES) {
		const folder = await ctx.db
			.query('mailFolders')
			.withIndex('by_mailbox_and_role', (q) => q.eq('mailboxId', mailboxId).eq('role', role))
			.first();
		folderIds[role] = folder?._id ?? null;
		if (role === 'inbox') inboxUnread = folder?.unseenCount ?? 0;
	}
	return { folderIds, inboxUnread };
}
