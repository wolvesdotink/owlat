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
import {
	failedActionStatus,
	type ActionStatus,
	type Effect,
	type ProcessingStatus,
	type TransitionInput,
	type TransitionOutcome,
} from './types';
import { canFail, PROCESSING_LIFECYCLE, reduce } from './reducers';

// ─── Constants ──────────────────────────────────────────────────────────────

/**
 * Default undo / send-delay window for AUTONOMOUS auto-sends when
 * `agentConfig.autoSendDelayMs` is unset. Mirrors the manual Postbox undo
 * (mail/draftLifecycle.ts `DEFAULT_UNDO_SEND_DELAY_MS`, 30s) but leans longer
 * for unattended sends so a landing customer reply or a human "Undo" has room
 * to abort a now-stale reply before it goes out. `0` preserves the legacy
 * immediate-send behaviour (`runAfter(0)`, no cancellable marker).
 */
export const DEFAULT_AUTO_SEND_DELAY_MS = 60_000;

/**
 * Default undo window for HUMAN approvals on the review surfaces
 * (`agentConfig.humanApproveUndoDelayMs` unset). Shorter than the autonomous
 * window above: a human just read the draft, so the window only needs to cover
 * an immediate "wait, no" — while every extra second is felt reply latency on
 * every send. `0` restores the legacy immediate human send.
 */
export const DEFAULT_HUMAN_APPROVE_UNDO_DELAY_MS = 15_000;

/** Ceiling for the human-approve undo window — 2 minutes of held replies is
 * already a lot of felt latency; anything larger is a misconfiguration. */
export const MAX_HUMAN_APPROVE_UNDO_DELAY_MS = 120_000;

/** Clamp a configured human-approve undo window into [0, 120000]. */
export function clampHumanApproveUndoDelayMs(value: number): number {
	if (!Number.isFinite(value)) return DEFAULT_HUMAN_APPROVE_UNDO_DELAY_MS;
	return Math.min(MAX_HUMAN_APPROVE_UNDO_DELAY_MS, Math.max(0, Math.round(value)));
}

/** Resolve `agentConfig.humanApproveUndoDelayMs` (absent ⇒ 15s default) into
 * the effective clamped window a human approve should honor. */
export function resolveHumanApproveUndoDelayMs(configured: number | undefined): number {
	return configured === undefined
		? DEFAULT_HUMAN_APPROVE_UNDO_DELAY_MS
		: clampHumanApproveUndoDelayMs(configured);
}

// ─── Runner ─────────────────────────────────────────────────────────────────

export async function applyEffects(
	ctx: MutationCtx,
	effects: ReadonlyArray<Effect>
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
				const retryCount = action.retryCount + 1;
				await ctx.db.patch(effect.actionId, {
					// Exhausted retries → terminal `abandoned`, keeping the retry
					// cron's `by_status='failed'` scan free of dead rows.
					status: failedActionStatus(retryCount),
					errorMessage: effect.errorMessage,
					completedAt: Date.now(),
					retryCount,
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
				// Human-reviewed approvals honor the per-call undo window the
				// approve mutation resolved from `agentConfig.humanApproveUndoDelayMs`,
				// reusing the same cancellable `pendingAutoSend` marker (and thus the
				// same `undoAutoSend` → `approved → draft_ready` fail-soft path) as
				// autonomous sends. Callers that pass no delay keep the legacy
				// immediate send.
				if (!effect.autonomous) {
					const delayMs = Math.max(0, effect.delayMs ?? 0);
					if (delayMs === 0) {
						// Immediate send — the window is off (delay 0 / not threaded),
						// so a human sign-off ships now and there is nothing to undo.
						await ctx.scheduler.runAfter(0, internal.agent.agentPipeline.sendApprovedReply, {
							inboundMessageId: effect.inboundMessageId,
							autonomous: false,
						});
						break;
					}

					const now = Date.now();
					const scheduledFnId = await ctx.scheduler.runAfter(
						delayMs,
						internal.agent.agentPipeline.sendApprovedReply,
						{ inboundMessageId: effect.inboundMessageId, autonomous: false }
					);
					await ctx.db.patch(effect.inboundMessageId, {
						pendingAutoSend: {
							scheduledFnId,
							sendAt: now + delayMs,
							scheduledAt: now,
						},
					});
					break;
				}

				// Resolve the delay from the singleton agentConfig; fail soft to
				// the default when unconfigured. Clamp to >= 0.
				const configs = await ctx.db.query('agentConfig').take(1);
				const configuredDelay = configs[0]?.autoSendDelayMs;
				const delayMs = Math.max(0, configuredDelay ?? DEFAULT_AUTO_SEND_DELAY_MS);

				const now = Date.now();
				const scheduledFnId = await ctx.scheduler.runAfter(
					delayMs,
					internal.agent.agentPipeline.sendApprovedReply,
					{ inboundMessageId: effect.inboundMessageId, autonomous: true }
				);

				// delay=0 is the legacy immediate path — no undo window, so no
				// cancellable marker to record.
				if (delayMs > 0) {
					await ctx.db.patch(effect.inboundMessageId, {
						pendingAutoSend: {
							scheduledFnId,
							sendAt: now + delayMs,
							scheduledAt: now,
						},
					});
				}
				break;
			}
			case 'schedule_pipeline_start': {
				await ctx.scheduler.runAfter(0, internal.agent.walker.start, {
					inboundMessageId: effect.inboundMessageId,
				});
				break;
			}
			case 'schedule_knowledge_extraction': {
				// Mine the message for typed knowledge once it has been
				// classified. Best-effort and idempotent: extractFromMessage
				// no-ops on short bodies and the extractor swallows its own
				// errors so a failed extraction can't fail the transition.
				await ctx.scheduler.runAfter(0, internal.knowledge.extraction.extractFromMessage, {
					inboundMessageId: effect.inboundMessageId,
				});
				break;
			}
			case 'schedule_code_task': {
				// Turn a classified feature request into a code-work task.
				// Gated on the inbox.codeTasks flag inside createFromInbound;
				// idempotent on inboundMessageId.
				await ctx.scheduler.runAfter(0, internal.codeWorkTasks.createFromInbound, {
					inboundMessageId: effect.inboundMessageId,
				});
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
	input: TransitionInput
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
		if (PROCESSING_LIFECYCLE.isTerminal(from)) {
			return { ok: false, reason: 'terminal', from, to: input.to };
		}
	} else if (!PROCESSING_LIFECYCLE.isLegalEdge(from, input.to)) {
		// Deliberately `isLegalEdge` rather than the core's `classify`: this
		// machine has never granted the implicit self-loop pass, and a same-state
		// re-drive (`drafting → drafting`) must keep refusing rather than
		// re-running the reducer and re-firing its effects.
		return {
			ok: false,
			reason: PROCESSING_LIFECYCLE.isTerminal(from) ? 'terminal' : 'illegal_edge',
			from,
			to: input.to,
		};
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
