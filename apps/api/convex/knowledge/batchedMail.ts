/**
 * Resume a Postbox message's knowledge extraction after its provider batch
 * result arrived (ADR-0073, L14; `aiRouting/batchItems.ts`). The result is the
 * message's `in_progress` extraction marker; this re-runs the extraction the
 * way both of its callers do (`mail/migrationIndexing.ts` `indexOneMessage`,
 * `mail/liveKnowledge.ts` `extractLiveMessage`): screened, and scoped to the
 * sender's contact, which the extraction's arguments carry and the batch item
 * does not store. The extraction then saves the marker's entries without
 * asking the model again.
 */

import { v } from 'convex/values';
import { internalAction } from '../_generated/server';
import { internal } from '../_generated/api';
import { loadExtractableMail } from '../mail/knowledgeScreen';
import { anchorActionDeadline, boundedRoot } from '../lib/llm/actionDeadline';
import { rootRequest } from '../lib/llm/requestMeter';

export const resumeMailExtraction = internalAction({
	args: { mailMessageId: v.id('mailMessages') },
	handler: async (ctx, args) => {
		// One model budget for this action, from its start (ADR-0073).
		anchorActionDeadline(ctx);
		// Gone, or phishing/spoofed mail that must not feed the graph.
		const msg = await loadExtractableMail(ctx, args.mailMessageId);
		if (!msg) return;
		const { contactId } = await ctx.runMutation(
			internal.mail.migrationIndexing.resolveSenderContact,
			{ email: msg.fromAddress, fromName: msg.fromName ?? undefined }
		);
		// The callers' rule: an unresolvable sender would land org-general.
		if (!contactId) return;
		await ctx.runAction(internal.knowledge.extraction.extractFromMailMessage, {
			mailMessageId: args.mailMessageId,
			contactIds: [contactId],
			// Awaited: it spends from this action's clock (ADR-0073).
			root: boundedRoot(ctx, rootRequest('postbox', args.mailMessageId)),
		});
	},
});
