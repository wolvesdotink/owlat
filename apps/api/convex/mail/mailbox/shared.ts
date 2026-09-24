/**
 * Pieces shared by the `mail/mailbox/*` modules — the sharing-model read
 * (`mailboxScope`), the system-folder catalog (written at provision time by
 * `identity.provisionMailbox`, read back as a `role` filter by the read views)
 * and the soft-auth session read the anonymous-tolerant `publicQuery` handlers
 * use.
 *
 * Nothing here is a Convex function; it is the common vocabulary of the
 * mailbox subdomain, split out so `identity.ts`, `queries.ts`, `messages.ts`
 * and `search.ts` do not import one another just to reach a constant.
 */

import type { Doc } from '../../_generated/dataModel';
import { literalUnion } from '../../lib/convexValidators';
import { getBetterAuthSessionWithRole } from '../../lib/sessionOrganization';

/** A mailbox's sharing model; see `mailboxes.scope` in schema/mailboxes.ts. */
export type MailboxScope = NonNullable<Doc<'mailboxes'>['scope']>;

/**
 * The mailbox's sharing model, with the legacy unset value read as 'personal'.
 * `mailboxes.scope` is the only record of whether a mailbox is someone's own
 * inbox or org infrastructure: the transport (`kind`) and the external account
 * behind it never override it.
 */
export function mailboxScope(mailbox: Pick<Doc<'mailboxes'>, 'scope'>): MailboxScope {
	return mailbox.scope ?? 'personal';
}

/**
 * The six folders every mailbox is provisioned with. Also the accepted
 * `folderRole` values on the read views (`queries.listMessages`,
 * `queries.listThreads`, `search.search`).
 */
export const SYSTEM_FOLDER_ROLES = ['inbox', 'sent', 'drafts', 'trash', 'spam', 'archive'] as const;
export type FolderRole = (typeof SYSTEM_FOLDER_ROLES)[number];
/** The same six roles as a Convex validator, for `mailFolders.role` and the folder-scoped args. */
export const folderRoleValidator = literalUnion(SYSTEM_FOLDER_ROLES);

export const SYSTEM_FOLDER_NAMES: Record<FolderRole, string> = {
	inbox: 'INBOX',
	sent: 'Sent',
	drafts: 'Drafts',
	trash: 'Trash',
	spam: 'Spam',
	archive: 'Archive',
};

/**
 * The caller's org session, or null when there is no usable one. The
 * soft-auth mailbox surfaces (`identity.list`, `queries.accessible`,
 * `queries.newestUnreadInbox`) return an empty result for null rather than
 * throwing, so an anonymous visitor sees nothing instead of an error.
 */
export async function readSession(ctx: Parameters<typeof getBetterAuthSessionWithRole>[0]) {
	const s = await getBetterAuthSessionWithRole(ctx);
	if (!s || !s.activeOrganizationId || !s.role) return null;
	return {
		userId: s.userId,
		role: s.role,
		activeOrganizationId: s.activeOrganizationId,
	};
}
