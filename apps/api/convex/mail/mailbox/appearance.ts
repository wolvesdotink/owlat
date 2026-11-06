/**
 * Inbox identity — the short name, colour and mark an inbox wears everywhere a
 * reply can start (sidebar, Today, Answer queue, reader, composer "Send as …").
 *
 * The name is the existing `mailboxes.displayName`; the colour is a slot into
 * the web's fixed four-colour set (`colorSlot`); the mark is an icon key or one
 * emoji (`mark`). Editing any of them needs owner rights on the mailbox: the
 * mailbox's own user, an org owner/admin, or an `owner` member of a shared
 * inbox.
 */

import { v } from 'convex/values';
import { throwForbidden, throwInvalidInput } from '../../_utils/errors';
import { validateStringLength } from '../../lib/inputGuards';
import { postboxMutation } from '../_helpers';
import { requireMailboxAccess } from '../permissions';

/** Slots the web palette defines (see apps/web utils/inboxIdentity.ts). */
export const INBOX_COLOR_SLOTS = 4;
const DISPLAY_NAME_MAX = 40;

/** Icon marks the web can draw (see apps/web utils/inboxIdentity.ts). */
export const INBOX_MARK_ICONS = ['home', 'work', 'team', 'shop'] as const;

// One emoji grapheme: a flag (two regional indicators), a keycap, or a
// pictograph with its optional variation selector, skin tone and tag sequence,
// ZWJ-joined to more of the same. Written out because the Convex runtime does
// not promise `Intl.Segmenter`.
const PICTOGRAPH = String.raw`\p{Extended_Pictographic}(?:\uFE0F|\p{Emoji_Modifier})?(?:[\u{E0020}-\u{E007E}]+\u{E007F})?`;
const SINGLE_EMOJI = new RegExp(
	String.raw`^(?:\p{Regional_Indicator}{2}|[#*0-9]\uFE0F?\u20E3|${PICTOGRAPH}(?:\u200D${PICTOGRAPH})*)$`,
	'u'
);
// Bounds the pattern's work. The longest emoji sequences (a ZWJ family with
// skin tones) are about 20 UTF-16 units.
const MARK_MAX = 32;

/** The stored form of a mark, or null when it is neither an icon key nor one emoji. */
export function normalizeInboxMark(raw: string): string | null {
	const mark = raw.trim();
	if (mark.length === 0 || mark.length > MARK_MAX) return null;
	if ((INBOX_MARK_ICONS as readonly string[]).includes(mark)) return mark;
	return SINGLE_EMOJI.test(mark) ? mark : null;
}

// authz: requireMailboxAccess(…, 'owner') — only an inbox owner renames, recolours or re-marks it.
export const setAppearance = postboxMutation({
	args: {
		mailboxId: v.id('mailboxes'),
		displayName: v.optional(v.string()),
		// null clears the slot back to the position-derived default.
		colorSlot: v.optional(v.union(v.number(), v.null())),
		// An icon key or one emoji; null clears it back to the provider logo or initials.
		mark: v.optional(v.union(v.string(), v.null())),
	},
	handler: async (ctx, args) => {
		const access = await requireMailboxAccess(ctx, args.mailboxId, 'owner');
		if (!access.ok) throwForbidden('Only an owner of this inbox can change how it looks');

		const patch: {
			displayName?: string;
			colorSlot?: number;
			mark?: string;
			updatedAt: number;
		} = {
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
		if (args.mark === null) {
			patch.mark = undefined;
		} else if (args.mark !== undefined) {
			const mark = normalizeInboxMark(args.mark);
			if (mark === null) throwInvalidInput('An inbox mark is one of the icons or a single emoji');
			patch.mark = mark;
		}
		await ctx.db.patch(args.mailboxId, patch);
		return { success: true };
	},
});
