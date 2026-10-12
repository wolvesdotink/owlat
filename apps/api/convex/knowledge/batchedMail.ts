/**
 * Resume a Postbox message's knowledge extraction after its provider batch
 * result arrived (ADR-0073, L14; `aiRouting/batchItems.ts`). The result is the
 * message's `in_progress` extraction marker; this re-runs the extraction with
 * the live path's guards (`mail/liveKnowledge.ts` `extractLiveMessage`): the
 * `ai.knowledge` flag, the folder recheck, the screen, and the sender's
 * contact, which the extraction's arguments carry and the batch item does not
 * store. Only mail that was in an extractable folder is ever batched
 * (`knowledge/extraction.ts`), so the import sweep's mail resumes the same
 * way. A refused guard drops the result (the batch is already billed and
 * settled). The extraction then saves the marker's entries without asking the
 * model again.
 */

import { v } from 'convex/values';
import { internalAction } from '../_generated/server';
import { internal } from '../_generated/api';
import { loadExtractableMail } from '../mail/knowledgeScreen';
import { anchorActionDeadline, boundedRoot } from '../lib/llm/actionDeadline';
import { rootRequest } from '../lib/llm/requestMeter';
import { isKnowledgeOn } from './extractionPolicy';

export const resumeMailExtraction = internalAction({
	args: { mailMessageId: v.id('mailMessages') },
	handler: async (ctx, args) => {
		// One model budget for this action, from its start (ADR-0073).
		anchorActionDeadline(ctx);
		// Every guard the live path runs, rechecked now: the batch was out for
		// up to a day (Sol r2 F1). A refusal drops the batch's result.
		const refuse = () =>
			ctx.runMutation(internal.knowledge.extractionProgress.dropUnfinishedExtraction, {
				sourceType: 'email',
				sourceId: args.mailMessageId,
			});
		if (!(await isKnowledgeOn(ctx, '[knowledge.batchedMail]'))) return refuse();
		// Moved to Spam, Trash, Sent or Drafts while the batch was out.
		if (!(await ctx.runQuery(internal.mail.liveKnowledge.isInExtractableFolder, args))) {
			return refuse();
		}
		// Gone, or phishing/spoofed mail that must not feed the graph.
		const msg = await loadExtractableMail(ctx, args.mailMessageId);
		if (!msg) return refuse();
		const { contactId } = await ctx.runMutation(
			internal.mail.migrationIndexing.resolveSenderContact,
			{ email: msg.fromAddress, fromName: msg.fromName ?? undefined }
		);
		// The callers' rule: an unresolvable sender would land org-general.
		if (!contactId) return refuse();
		await ctx.runAction(internal.knowledge.extraction.extractFromMailMessage, {
			mailMessageId: args.mailMessageId,
			contactIds: [contactId],
			// Awaited: it spends from this action's clock (ADR-0073).
			root: boundedRoot(ctx, rootRequest('postbox', args.mailMessageId)),
		});
	},
});
