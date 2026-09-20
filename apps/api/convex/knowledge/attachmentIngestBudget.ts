/**
 * The AI-spend budget for attachment ingestion.
 *
 * `captureAttachments` runs on a route any sender can reach, and every part it
 * hands to `semanticFiles.ingest` schedules `processFile` — one summarize
 * completion, one embedding, and for anything with real extracted text a
 * further extract completion plus one embedding per knowledge entry. The
 * existing `agentPipelinePerSender`/`agentPipelineGlobal` pair gates the
 * DRAFTING pipeline, not this, so attachment-driven spend bypassed it entirely.
 *
 * Charged at the capture site rather than inherited from the route, because the
 * route's per-IP bucket is one shared bucket on any deployment without
 * `RATE_LIMIT_TRUSTED_PROXY` set.
 *
 * A MUTATION because the limiter writes its component's state; `ingest.ts`
 * reaches it through `ctx.runMutation` from its action.
 */

import { v } from 'convex/values';
import { ATTACHMENT_COMPOSE_LIMITS } from '@owlat/shared/attachments';
import { internalMutation } from '../_generated/server';
import { rateLimiter } from '../rateLimiter';

export const consumeAttachmentIngestBudget = internalMutation({
	args: {
		/**
		 * The resolved sender contact id, or the normalized sender email when no
		 * contact matched. Spoofable by construction — a forged From: mints a
		 * fresh bucket — which is exactly why the global bucket is charged too.
		 */
		senderKey: v.string(),
		/** How many attachment leaves are about to be ingested. */
		count: v.number(),
	},
	returns: v.object({ ok: v.boolean() }),
	handler: async (ctx, args): Promise<{ ok: boolean }> => {
		if (args.count <= 0) return { ok: true };
		// `rateLimiter.limit` THROWS when `count` exceeds a bucket's capacity
		// rather than refusing, and a throw on this path would surface as a
		// logged capture failure. The only caller already caps its batch at the
		// per-message part limit, which is well under both capacities; clamping
		// here makes that an enforced boundary rather than an assumed one.
		const count = Math.min(args.count, ATTACHMENT_COMPOSE_LIMITS.maxCount);
		// Per-sender first, then global only if that passed — the same idiom the
		// agent-pipeline gate in inbox/messages.ts uses, so a sender already over
		// their own cap cannot also drain the instance's.
		const perSender = await rateLimiter.limit(ctx, 'attachmentIngestPerSender', {
			key: args.senderKey,
			count,
		});
		if (!perSender.ok) return { ok: false };
		const global = await rateLimiter.limit(ctx, 'attachmentIngestGlobal', {
			key: 'global',
			count,
		});
		return { ok: global.ok };
	},
});
