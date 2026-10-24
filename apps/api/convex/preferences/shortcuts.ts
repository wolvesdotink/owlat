/**
 * The keyboard map a person drives the whole app with: a named preset plus
 * their own per-shortcut remaps.
 *
 * Stored on the person's `mailUserSettings` row, where the Postbox-only
 * version of the shortcuts page kept it, and read back through the soft-auth
 * `mail.settings.get`, which carries no feature floor. Written HERE rather
 * than through `mail.settings.update`: shortcuts cover every surface, so a
 * member of an instance with neither personal-mail flag on must be able to
 * remap them, while the mail reading preferences keep their gated mutation.
 * This door writes the two keyboard fields and nothing else.
 */

import { v } from 'convex/values';
import { authedMutation } from '../lib/authedFunctions';
import { validateStringLength } from '../lib/inputGuards';
import { throwInvalidInput } from '../_utils/errors';
import {
	mailShortcutOverridesValidator,
	mailShortcutPresetValidator,
} from '../lib/validators/mailSettings';

/**
 * Bounds well above anything the web writes (the catalog holds under a
 * hundred ids, each with a handful of chords) and far below the builders'
 * generic string ceiling, so a hand-made call cannot park megabytes on a row
 * every dashboard load reads.
 */
const MAX_OVERRIDES = 200;
const MAX_CHORDS_PER_OVERRIDE = 10;
const MAX_ID_LENGTH = 100;
const MAX_CHORD_LENGTH = 64;

export const update = authedMutation({
	args: {
		shortcutPreset: v.optional(mailShortcutPresetValidator),
		shortcutOverrides: v.optional(mailShortcutOverridesValidator),
	},
	// authz: self-scoped — upserts only the caller's own settings row (keyed by
	// the session userId; no cross-user id is accepted).
	handler: async (ctx, args, session) => {
		const overrides = args.shortcutOverrides;
		if (overrides !== undefined) {
			if (overrides.length > MAX_OVERRIDES) {
				throwInvalidInput(`shortcutOverrides must hold at most ${MAX_OVERRIDES} entries`);
			}
			for (const row of overrides) {
				validateStringLength(row.id, MAX_ID_LENGTH, 'shortcutOverrides.id');
				if (row.keys.length > MAX_CHORDS_PER_OVERRIDE) {
					throwInvalidInput(
						`shortcutOverrides.keys must hold at most ${MAX_CHORDS_PER_OVERRIDE} chords`
					);
				}
				for (const key of row.keys) {
					validateStringLength(key, MAX_CHORD_LENGTH, 'shortcutOverrides.keys');
				}
			}
		}

		const patch: {
			shortcutPreset?: (typeof args)['shortcutPreset'];
			shortcutOverrides?: (typeof args)['shortcutOverrides'];
		} = {};
		if (args.shortcutPreset !== undefined) patch.shortcutPreset = args.shortcutPreset;
		if (overrides !== undefined) patch.shortcutOverrides = overrides;

		const existing = await ctx.db
			.query('mailUserSettings')
			.withIndex('by_user', (q) => q.eq('userId', session.userId))
			.first();
		const now = Date.now();
		if (existing) {
			await ctx.db.patch(existing._id, { ...patch, updatedAt: now });
			return existing._id;
		}
		return ctx.db.insert('mailUserSettings', {
			// The row's one required preference; the same default the mail
			// settings write when a person first saves anything else.
			autoAdvance: 'next',
			...patch,
			userId: session.userId,
			createdAt: now,
			updatedAt: now,
		});
	},
});
