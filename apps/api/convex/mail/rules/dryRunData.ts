/**
 * Read on arrival: the data half of "Test on recent mail". The
 * rule under test (a draft on screen, or a saved filter) is evaluated against
 * the newest 50 Inbox messages with the SAME deterministic predicate delivery
 * uses (`filtersEval.ts`), from the stored fields. The AI condition is left
 * to the action (`dryRun.ts`), which asks it once for every message the
 * deterministic part matched.
 */

import { v } from 'convex/values';
import { internalQuery } from '../../_generated/server';
import type { Id } from '../../_generated/dataModel';
import { requireMailboxAccess } from '../permissions';
import { evalMessageFromRow, filterConditionsMatch } from '../filtersEval';
import { mailFilterConditionValidator, mailFilterMatchTypeValidator } from '../../schema/mailRules';
import { MAX_AI_QUESTION_CHARS } from '../filterValidation';

/** How much recent Inbox mail a dry run reads (§6.2). */
export const DRY_RUN_MESSAGES = 50;

export const dryRunDraftValidator = v.object({
	conditions: v.array(mailFilterConditionValidator),
	matchType: v.optional(mailFilterMatchTypeValidator),
	aiQuestion: v.optional(v.string()),
});

/** One message of the dry run, with its deterministic verdict. */
export interface DryRunMessage {
	messageId: Id<'mailMessages'>;
	fromAddress: string;
	fromName?: string;
	subject: string;
	receivedAt: number;
	isDeterministicMatch: boolean;
}

export interface DryRunData {
	messages: DryRunMessage[];
	aiQuestion?: string;
	ownerUserId: string;
}

/** The rule and the newest 50 Inbox messages, deterministically evaluated; null without owner access. */
export const loadDryRun = internalQuery({
	args: {
		mailboxId: v.id('mailboxes'),
		filterId: v.optional(v.id('mailFilters')),
		draft: v.optional(dryRunDraftValidator),
	},
	handler: async (ctx, args): Promise<DryRunData | null> => {
		const owned = await requireMailboxAccess(ctx, args.mailboxId, 'owner');
		if (!owned.ok) return null;
		const saved = args.filterId ? await ctx.db.get(args.filterId) : null;
		if (args.filterId && (!saved || saved.mailboxId !== args.mailboxId)) return null;
		const rule = saved
			? {
					conditions: saved.conditions,
					matchType: saved.matchType,
					aiQuestion: saved.aiCondition?.question,
				}
			: args.draft;
		if (!rule) return null;
		const aiQuestion = rule.aiQuestion?.trim().slice(0, MAX_AI_QUESTION_CHARS) || undefined;
		const inbox = await ctx.db
			.query('mailFolders')
			.withIndex('by_mailbox_and_role', (q) =>
				q.eq('mailboxId', args.mailboxId).eq('role', 'inbox')
			)
			.first();
		const mailbox = await ctx.db.get(args.mailboxId);
		if (!inbox || !mailbox) return null;
		const recent = await ctx.db
			.query('mailMessages')
			.withIndex('by_folder_and_received', (q) => q.eq('folderId', inbox._id))
			.order('desc')
			.take(DRY_RUN_MESSAGES);
		const messages: DryRunMessage[] = [];
		for (const message of recent) {
			// An empty deterministic part matches when an AI condition decides (§6.2 rule 3).
			const isDeterministicMatch =
				rule.conditions.length === 0
					? aiQuestion !== undefined
					: filterConditionsMatch(rule, await evalMessageFromRow(ctx.db, message, rule));
			messages.push({
				messageId: message._id,
				fromAddress: message.fromAddress,
				...(message.fromName ? { fromName: message.fromName } : {}),
				subject: message.subject,
				receivedAt: message.receivedAt,
				isDeterministicMatch,
			});
		}
		return { messages, ...(aiQuestion ? { aiQuestion } : {}), ownerUserId: mailbox.userId };
	},
});
