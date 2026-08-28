/**
 * Gmail filter import (idea 50) — the write half.
 *
 * Gmail's "export filters" gives an Atom XML file of criteria and actions. The
 * browser parses and TRANSLATES it (`apps/web/app/utils/gmailFilterImport.ts`),
 * which is where the vocabulary mapping and the honest report of what could not
 * be translated live; this mutation is what lands the survivors.
 *
 * It takes label and folder NAMES rather than ids on purpose. The client has no
 * business minting labels one round-trip at a time and then racing another tab
 * for the ids: here, one transaction resolves every name — creating a missing
 * label through the same `resolveLabelPath` the archive import uses — and
 * inserts the filters, so a partial import is impossible.
 *
 * Re-importing the same file creates nothing: a filter whose name already exists
 * in this mailbox is skipped and counted. Gmail has no filter ids to dedup on,
 * and the name is what the user sees.
 */

import { v } from 'convex/values';
import { authedMutation } from '../lib/authedFunctions';
import type { Id } from '../_generated/dataModel';
import { throwForbidden } from '../_utils/errors';
import { requireMailboxAccess } from './permissions';
import { resolveLabelPath } from './labels';

/** Filters accepted in one import. Gmail's own limit is well under this. */
const MAX_IMPORTED_FILTERS = 100;

const importedConditionValidator = v.object({
	field: v.union(
		v.literal('from'),
		v.literal('to'),
		v.literal('subject'),
		v.literal('body'),
		v.literal('hasAttachment')
	),
	op: v.union(v.literal('contains'), v.literal('notContains'), v.literal('isTrue')),
	value: v.optional(v.string()),
});

const importedActionValidator = v.object({
	type: v.union(
		v.literal('addLabel'),
		v.literal('moveToFolder'),
		v.literal('markRead'),
		v.literal('markFlagged')
	),
	/** For `addLabel` — a label PATH; missing segments are created. */
	labelName: v.optional(v.string()),
	/** For `moveToFolder` — a system folder role. */
	folderRole: v.optional(v.union(v.literal('archive'), v.literal('trash'), v.literal('spam'))),
});

/**
 * Create the translated filters in the caller's mailbox.
 *
 * Owner-grade, like `filters.create`: a filter changes how a mailbox routes mail
 * for everyone who reads it.
 */
// authz: self — requireMailboxAccess at owner level, the same gate filters.create uses
export const importGmailFilters = authedMutation({
	args: {
		mailboxId: v.id('mailboxes'),
		filters: v.array(
			v.object({
				name: v.string(),
				conditions: v.array(importedConditionValidator),
				actions: v.array(importedActionValidator),
			})
		),
	},
	handler: async (
		ctx,
		args
	): Promise<{ created: number; skipped: number; labelsCreated: number }> => {
		const owned = await requireMailboxAccess(ctx, args.mailboxId, 'owner');
		if (!owned.ok) throwForbidden('Mailbox not accessible');

		const existing = await ctx.db
			.query('mailFilters')
			.withIndex('by_mailbox_and_priority', (q) => q.eq('mailboxId', args.mailboxId))
			.collect(); // bounded: one mailbox's filters
		const takenNames = new Set(existing.map((filter) => filter.name.trim().toLowerCase()));
		let priority =
			existing.length === 0 ? 100 : Math.max(...existing.map((filter) => filter.priority)) + 100;

		let created = 0;
		let skipped = 0;
		let labelsCreated = 0;
		const now = Date.now();

		for (const incoming of args.filters.slice(0, MAX_IMPORTED_FILTERS)) {
			const name = incoming.name.trim().slice(0, 120);
			if (!name || incoming.conditions.length === 0 || incoming.actions.length === 0) {
				skipped++;
				continue;
			}
			if (takenNames.has(name.toLowerCase())) {
				skipped++;
				continue;
			}

			const actions: Array<{
				type: 'addLabel' | 'moveToFolder' | 'markRead' | 'markFlagged';
				labelId?: Id<'mailLabels'>;
				folderId?: Id<'mailFolders'>;
			}> = [];
			for (const action of incoming.actions) {
				if (action.type === 'addLabel') {
					if (!action.labelName) continue;
					const label = await resolveLabelPath(ctx, args.mailboxId, action.labelName);
					if (!label) continue;
					labelsCreated += label.created;
					actions.push({ type: 'addLabel', labelId: label.labelId });
					continue;
				}
				if (action.type === 'moveToFolder') {
					if (!action.folderRole) continue;
					const folder = await ctx.db
						.query('mailFolders')
						.withIndex('by_mailbox_and_role', (q) =>
							q.eq('mailboxId', args.mailboxId).eq('role', action.folderRole)
						)
						.first();
					// A mailbox missing the destination folder drops that ACTION, not
					// the whole filter — the label half of a Gmail rule is usually the
					// half that matters.
					if (!folder) continue;
					actions.push({ type: 'moveToFolder', folderId: folder._id });
					continue;
				}
				actions.push({ type: action.type });
			}
			if (actions.length === 0) {
				skipped++;
				continue;
			}

			await ctx.db.insert('mailFilters', {
				mailboxId: args.mailboxId,
				name,
				isEnabled: true,
				priority,
				conditions: incoming.conditions,
				actions,
				// Gmail ANDs its criteria, which is `all` — the absent default.
				stopProcessing: false,
				createdAt: now,
				updatedAt: now,
			});
			takenNames.add(name.toLowerCase());
			priority += 100;
			created++;
		}

		if (created > 0) {
			await ctx.db.insert('mailAuditLog', {
				mailboxId: args.mailboxId,
				event: 'filters.imported',
				details: `created=${created} skipped=${skipped}`,
				occurredAt: now,
			});
		}
		return { created, skipped, labelsCreated };
	},
});
