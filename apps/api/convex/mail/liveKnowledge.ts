/**
 * Live Postbox mail → knowledge graph.
 *
 * Mail that ARRIVES in a Postbox mailbox (hosted MX delivery or external IMAP
 * sync) lands in `mailMessages`, not in the AI inbox's `inboundMessages`, so the
 * agent pipeline's `schedule_knowledge_extraction` effect never sees it. Before
 * this module, the only road from `mailMessages` into the knowledge graph was a
 * mailbox import's one-off indexing sweep (`mail/migrationIndexing.ts`): an
 * instance whose mail all came from connected mailboxes learned nothing from
 * anything that arrived after the import, however long it ran.
 *
 * The shared post-insert tail (`deliveryPipeline/afterInsert.ts`) asks
 * `shouldExtractLiveMessage`, which gates on the same things the AI inbox
 * does before it extracts: the `ai.knowledge` flag, and mail that a person sent
 * (no RFC 3834 automated / list / bulk traffic). `extractLiveMessage` then scopes
 * the entries to the sender's contact exactly like the import sweep, so live and
 * imported mail retrieve through the same contact-scoped search.
 */

import { v } from 'convex/values';
import { internalAction, type MutationCtx } from '../_generated/server';
import { internal } from '../_generated/api';
import { isFeatureEnabled } from '../lib/featureFlags';
import { isAutomatedMail } from '../lib/inboundClassification';

/**
 * Whether one live inbound message should be extracted into the knowledge
 * graph. The caller has already ruled out backfill, Spam/Trash/Sent/Drafts,
 * and the mailbox owner's own mail, and schedules `extractLiveMessage`.
 */
export async function shouldExtractLiveMessage(
	ctx: MutationCtx,
	params: {
		spamVerdict?: 'ham' | 'spam' | 'quarantine';
		antiLoopHeaders?: Record<string, string>;
	}
): Promise<boolean> {
	if (params.spamVerdict === 'spam' || params.spamVerdict === 'quarantine') return false;
	// Newsletters, notifications and auto-replies are not organizational
	// knowledge, and extracting them is an LLM call per message.
	if (params.antiLoopHeaders && isAutomatedMail(params.antiLoopHeaders)) return false;
	return await isFeatureEnabled(ctx, 'ai.knowledge');
}

/**
 * Resolve the sender's contact and extract the message into the knowledge
 * graph. Idempotent (the extractor no-ops on a message that already produced
 * entries) and best-effort: a failure is logged by the extractor and never
 * touches delivery.
 */
export const extractLiveMessage = internalAction({
	args: { mailMessageId: v.id('mailMessages') },
	handler: async (ctx, args) => {
		const msg = await ctx.runQuery(internal.mail.migrationIndexing.getMessageForExtraction, {
			mailMessageId: args.mailMessageId,
		});
		if (!msg) return;
		const { contactId } = await ctx.runMutation(
			internal.mail.migrationIndexing.resolveSenderContact,
			{ email: msg.fromAddress, fromName: msg.fromName ?? undefined }
		);
		// Same rule as the import sweep: an unresolvable sender would land
		// org-general, visible in every contact's retrieval.
		if (!contactId) return;
		await ctx.runAction(internal.knowledge.extraction.extractFromMailMessage, {
			mailMessageId: args.mailMessageId,
			contactIds: [contactId],
		});
	},
});
