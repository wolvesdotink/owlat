/**
 * Route a message selection to a system folder of each message's OWN mailbox.
 *
 * A folder belongs to exactly one mailbox, and a selection made in All inboxes
 * spans several. The folder-routing verbs (archive, trash, spam, not spam)
 * therefore resolve the role folder once per mailbox the selection touches,
 * each behind that mailbox's access decision.
 *
 * Not a Convex function; a helper for `messageActions.ts`.
 */

import type { Doc, Id } from '../_generated/dataModel';
import type { MutationCtx } from '../_generated/server';
import type { createMailboxAccessGate } from './permissions';
import type { FolderRole } from '../lib/validators/mail';
import { throwForbidden, throwInvalidState } from '../_utils/errors';

export type RoleFolderGroup = {
	folderId: Id<'mailFolders'>;
	/** The selection's messages in this mailbox, in selection order. */
	messageIds: Id<'mailMessages'>[];
};

/**
 * One group per mailbox the selection touches, in the order the selection
 * first reaches each. A mailbox the caller cannot reach is left out; a
 * selection that reaches none is refused, as a single-mailbox call always was.
 * An empty or entirely missing selection yields no groups.
 */
export async function roleFolderGroups(
	ctx: MutationCtx,
	access: ReturnType<typeof createMailboxAccessGate>,
	messageIds: Id<'mailMessages'>[],
	role: FolderRole
): Promise<RoleFolderGroup[]> {
	const byMailbox = new Map<Id<'mailboxes'>, Id<'mailMessages'>[]>();
	for (const id of messageIds) {
		const message: Doc<'mailMessages'> | null = await ctx.db.get(id);
		if (!message) continue;
		const ids = byMailbox.get(message.mailboxId) ?? [];
		ids.push(id);
		byMailbox.set(message.mailboxId, ids);
	}
	const groups: RoleFolderGroup[] = [];
	for (const [mailboxId, ids] of byMailbox) {
		if (!(await access(mailboxId)).ok) continue;
		const folder = await ctx.db
			.query('mailFolders')
			.withIndex('by_mailbox_and_role', (q) => q.eq('mailboxId', mailboxId).eq('role', role))
			.first();
		if (!folder) throwInvalidState(`${role} folder missing`);
		groups.push({ folderId: folder._id, messageIds: ids });
	}
	if (byMailbox.size > 0 && groups.length === 0) throwForbidden('Messages not accessible');
	return groups;
}
