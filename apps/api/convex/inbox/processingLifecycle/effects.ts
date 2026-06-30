/**
 * Inbox processing lifecycle — effect runner + dispatcher.
 *
 * The impure half of the lifecycle: `applyEffects` is the ONLY place that
 * touches `ctx.db` and `ctx.scheduler`, applying the effect list the pure
 * reducers (`./reducers.ts`) produce. `dispatch` is the legal-edge gate that
 * runs the reducer, writes the message patch, applies the effects, and keeps
 * the singleton inbox-stats counter in sync. The public `internalMutation`s
 * in `../processingLifecycle.ts` are thin wrappers over `dispatch`.
 *
 * See docs/adr/0010-inbox-processing-lifecycle-module.md.
 */

import type { MutationCtx } from '../../_generated/server';
import { internal } from '../../_generated/api';
import type { Doc } from '../../_generated/dataModel';
import { transition as threadTransition } from '../threads/module';
import { applyInboxStatsDelta, bucketForStatus } from '../../lib/inboxStats';
import type {
	ActionStatus,
	Effect,
	ProcessingStatus,
	TransitionInput,
	TransitionOutcome,
} from './types';
import { canFail, LEGAL_EDGES, reduce, TERMINAL } from './reducers';

// ─── Runner ─────────────────────────────────────────────────────────────────

export async function applyEffects(
	ctx: MutationCtx,
	effects: ReadonlyArray<Effect>,
): Promise<void> {
	for (const effect of effects) {
		switch (effect.kind) {
			case 'complete_action': {
				const action = await ctx.db.get(effect.actionId);
				if (!action) break;
				await ctx.db.patch(effect.actionId, {
					status: 'completed' as ActionStatus,
					output: effect.output,
					completedAt: Date.now(),
					durationMs: effect.durationMs,
					modelUsed: effect.modelUsed,
					tokenUsage: effect.tokenUsage,
				});
				break;
			}
			case 'fail_action': {
				const action = await ctx.db.get(effect.actionId);
				if (!action) break;
				await ctx.db.patch(effect.actionId, {
					status: 'failed' as ActionStatus,
					errorMessage: effect.errorMessage,
					completedAt: Date.now(),
					retryCount: action.retryCount + 1,
				});
				break;
			}
			case 'reset_action_to_pending': {
				const action = await ctx.db.get(effect.actionId);
				if (!action) break;
				await ctx.db.patch(effect.actionId, {
					status: 'pending' as ActionStatus,
					errorMessage: undefined,
				});
				break;
			}
			case 'set_thread_draft_status': {
				// Delegate to the owning Conversation thread module rather than
				// patching `conversationThreads` in place — this was the one
				// inbox-lifecycle effect that wrote a table it doesn't own
				// (ADR-0032 §5). A vanished thread is reported, not thrown, so
				// it can't roll back the inbound message's own transition.
				await threadTransition(ctx, {
					threadId: effect.threadId,
					input: {
						kind: 'draft_status_change',
						latestDraftStatus: effect.draftStatus,
					},
				});
				break;
			}
			case 'schedule_send_approved': {
				await ctx.scheduler.runAfter(
					0,
					internal.agent.agentPipeline.sendApprovedReply,
					{ inboundMessageId: effect.inboundMessageId },
				);
				break;
			}
			case 'schedule_pipeline_start': {
				await ctx.scheduler.runAfter(
					0,
					internal.agent.walker.start,
					{ inboundMessageId: effect.inboundMessageId },
				);
				break;
			}
			case 'schedule_knowledge_extraction': {
				// Mine the message for typed knowledge once it has been
				// classified. Best-effort and idempotent: extractFromMessage
				// no-ops on short bodies and the extractor swallows its own
				// errors so a failed extraction can't fail the transition.
				await ctx.scheduler.runAfter(
					0,
					internal.knowledge.extraction.extractFromMessage,
					{ inboundMessageId: effect.inboundMessageId },
				);
				break;
			}
			case 'schedule_code_task': {
				// Turn a classified feature request into a code-work task.
				// Gated on the inbox.codeTasks flag inside createFromInbound;
				// idempotent on inboundMessageId.
				await ctx.scheduler.runAfter(
					0,
					internal.codeWorkTasks.createFromInbound,
					{ inboundMessageId: effect.inboundMessageId },
				);
				break;
			}
			case 'increment_auto_reply_count': {
				const configs = await ctx.db.query('agentConfig').take(1);
				if (configs.length === 0) break;
				const config = configs[0]!;
				const now = Date.now();
				const resetAt = config.dailyAutoReplyResetAt ?? 0;
				const isNewDay = now > resetAt;
				const midnight = new Date();
				midnight.setUTCHours(24, 0, 0, 0);
				await ctx.db.patch(config._id, {
					dailyAutoReplyCount: isNewDay ? 1 : (config.dailyAutoReplyCount ?? 0) + 1,
					dailyAutoReplyResetAt: isNewDay ? midnight.getTime() : resetAt,
				});
				break;
			}
		}
	}
}

// ─── Dispatcher ─────────────────────────────────────────────────────────────

export async function dispatch(
	ctx: MutationCtx,
	message: Doc<'inboundMessages'>,
	input: TransitionInput,
): Promise<TransitionOutcome> {
	const from = message.processingStatus as ProcessingStatus;

	// Failure can happen from any non-terminal state — star-source.
	if (input.to === 'failed') {
		if (!canFail(from)) {
			return { ok: false, reason: 'terminal', from, to: input.to };
		}
	} else if (input.to === 'archived' && from !== 'security_check') {
		// Block-sender / spam-from-classifier can archive from any
		// non-terminal state — star-source for archived too.
		if (TERMINAL.has(from)) {
			return { ok: false, reason: 'terminal', from, to: input.to };
		}
	} else {
		const isLegal = LEGAL_EDGES[from].has(input.to);
		if (!isLegal) {
			if (TERMINAL.has(from)) {
				return { ok: false, reason: 'terminal', from, to: input.to };
			}
			return { ok: false, reason: 'illegal_edge', from, to: input.to };
		}
	}

	const result = reduce(message, input);

	if (Object.keys(result.patch).length > 0) {
		await ctx.db.patch(message._id, result.patch as Partial<Doc<'inboundMessages'>>);
	}
	await applyEffects(ctx, result.effects);

	// Maintain the singleton `instanceSettings.inboxStats` counter doc so
	// `getInboundStats` does not have to `.collect()` the whole table on
	// every dashboard / badge subscriber.
	const fromBucket = bucketForStatus(from);
	const toBucket = bucketForStatus(input.to);
	if (fromBucket !== toBucket) {
		await applyInboxStatsDelta(ctx, fromBucket, toBucket);
	}

	return {
		ok: true,
		applied: result.applied,
		from,
		to: input.to,
	};
}
