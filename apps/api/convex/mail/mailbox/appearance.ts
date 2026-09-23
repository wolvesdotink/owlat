/**
 * Inbox identity — the short name and colour an inbox wears everywhere a reply
 * can start (sidebar, Today, Answer queue, reader, composer "Send as …").
 *
 * The name is the existing `mailboxes.displayName`; the colour is a slot into
 * the web's fixed four-colour set (`colorSlot`). Editing either needs owner
 * rights on the mailbox: the mailbox's own user, an org owner/admin, or an
 * `owner` member of a shared inbox.
 */

import { v } from 'convex/values';
import { throwForbidden, throwInvalidInput } from '../../_utils/errors';
import { validateStringLength } from '../../lib/inputGuards';
import { postboxMutation } from '../_helpers';
import { requireMailboxAccess } from '../permissions';

/** Slots the web palette defines (see apps/web utils/inboxIdentity.ts). */
export const INBOX_COLOR_SLOTS = 4;
const DISPLAY_NAME_MAX = 40;

// authz: requireMailboxAccess(…, 'owner') — only an inbox owner renames or recolours it.
export const setAppearance = postboxMutation({
	args: {
		mailboxId: v.id('mailboxes'),
		displayName: v.optional(v.string()),
		// null clears the slot back to the position-derived default.
		colorSlot: v.optional(v.union(v.number(), v.null())),
	},
	handler: async (ctx, args) => {
		const access = await requireMailboxAccess(ctx, args.mailboxId, 'owner');
		if (!access.ok) throwForbidden('Only an owner of this inbox can change how it looks');

		const patch: { displayName?: string; colorSlot?: number; updatedAt: number } = {
			updatedAt: Date.now(),
		};
		if (args.displayName !== undefined) {
			const name = args.displayName.trim();
			validateStringLength(name, DISPLAY_NAME_MAX, 'displayName');
			patch.displayName = name.length > 0 ? name : undefined;
		}
		if (args.colorSlot === null) {
			// Patching a field to undefined removes it.
			patch.colorSlot = undefined;
		} else if (args.colorSlot !== undefined) {
			const slot = args.colorSlot;
			if (!Number.isInteger(slot) || slot < 0 || slot >= INBOX_COLOR_SLOTS) {
				throwInvalidInput('Unknown inbox colour');
			}
			patch.colorSlot = slot;
		}
		await ctx.db.patch(args.mailboxId, patch);
		return { success: true };
	},
});
