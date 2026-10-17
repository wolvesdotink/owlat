'use node';

/**
 * Reply Queue classification action (see mail/needsReply.ts for the module
 * overview). Runs per-thread, scheduled by inbound ingest or the reconcile
 * cron:
 *
 *   1. Deterministic screen over the newest thread messages
 *      (mail/needsReplyHeuristic.ts). Not a candidate → clears the flag and
 *      finishes (no reply-queue model spend).
 *   2. Candidate → persists the deterministic flag FIRST (source `heuristic`,
 *      urgency `normal`), so a crash or model failure anywhere after this point
 *      still leaves the baseline signal (fail-soft). The baseline keeps the
 *      thread pending: a run that dies before the verdict (an OOM-killed
 *      backend, a restart) is classified again by the reconcile sweep, while
 *      a run that ends without a verdict on purpose (interpretation refused,
 *      failed or skipped, the result not persisting) settles it
 *      (mail/needsReplyPending.ts).
 *   3. Interpretation of the newest inbound message (mail/interpret/run.ts,
 *      SPEC §5 "Postbox") replaces the old reply-intent refinement call: the
 *      one model pass that fills the thread brief also NAMES the message from
 *      the closed reply-intent taxonomy (./replyIntent.ts), with urgency and
 *      any meeting request. The server still decides (`decideNeedsReply`
 *      through mail/interpret/needsReplyProjection.ts), so an FYI or a recap
 *      full of action items cannot promote itself, and an actionable item
 *      alone never implies a reply. Interpretation carries its own gate (the
 *      `ai` flag and the spend ceiling, mail/interpret/gate.ts) and frames the
 *      attacker-controlled body as untrusted data. The result only ever updates
 *      the advisory flag — it never sends or modifies mail.
 *   4. Clarification (whether a good reply misses a fact only the owner has)
 *      runs only when the decision needs a reply and the sender screener lets
 *      the sender into the queue (L3), behind the Postbox AI gate (`ai` flag,
 *      advisory budget, rate limit), with answer-memory fills.
 *
 * Delivery also hands over the message it just delivered
 * (`interpretMessageId`): it is interpreted here even when the thread is no
 * Reply Queue candidate (interpretation is wider than the queue), so the
 * delivery pipeline never schedules a second run for it.
 */

import { v, type ObjectType } from 'convex/values';
import { internalAction, type ActionCtx } from '../../_generated/server';
import { internal } from '../../_generated/api';
import type { Id } from '../../_generated/dataModel';
import { rootRequest, type LlmRootContext } from '../../lib/llm/requestMeter';
import { evaluateNeedsReplyCandidate } from '../needsReplyHeuristic';
import { runInterpretation, type InterpretRunResult } from '../interpret/run';
import {
	needsReplyResultOf,
	projectNeedsReply,
	type LatestInbound,
	type NeedsReplyProjection,
} from '../interpret/needsReplyProjection';
import { slotItemsOf, type SlotItem } from '../../inbox/clarificationSlots';
import type { BundleSubject } from '../../decision/bundleRunner';
import { applyMemoryFills } from '../../inbox/clarificationAnswers';
import { draftClarificationReply } from './needsReplyDraft';
import { continuesLater, isDeferredUntilOpen, isHeldOutByScreener } from './needsReplyGates';
import { refineClarification, type ClarificationFlag } from './needsReplyRefine';
import { logError } from '../../lib/runtimeLog';
import { anchorActionDeadline } from '../../lib/llm/actionDeadline';
import {
	BudgetDeferral,
	deferredHandler,
	rethrowAdmissionRefusal,
	type DeferrableAction,
} from '../../analytics/backgroundDeferral';

/**
 * The needs-reply inputs of a run, when the model read the message. A failed,
 * skipped or vanished run has none: the heuristic baseline then stands.
 */
function usableProjection(run: InterpretRunResult): NeedsReplyProjection | undefined {
	// A reused extraction reports its stored status (`isReplayed`), so the
	// same rule covers it.
	if (run.status !== 'complete' && run.status !== 'partial') return undefined;
	return run.projection;
}

/** Whether spend admission refused any call of the run (its code, or a reported refusal). */
export function isBudgetRefused(run: InterpretRunResult): boolean {
	if (run.status === 'gone' || !('errorCode' in run)) return false;
	return run.errorCode === 'budget' || run.budgetRefusal !== undefined;
}

/** This action, for its own budget deferral (ADR-0073, D1). */
const deferClassify = (): DeferrableAction => internal.mail.ai.needsReplyClassify.classifyThread;

const classifyThreadArgs = {
	threadId: v.id('mailThreads'),
	// Ingest-time headers of the triggering message — only available on the
	// ingest trigger (none of them are persisted on the row, so the reconcile
	// sweep re-classifies without them and leans on the sender screens).
	precedence: v.optional(v.string()),
	/** RFC 3834 Auto-Submitted. */
	autoSubmitted: v.optional(v.string()),
	/** RFC 2919 List-Id. */
	listId: v.optional(v.string()),
	/** The message delivery just landed (live mail only): interpreted by this run. */
	interpretMessageId: v.optional(v.id('mailMessages')),
	/** Runs this work deferred at the spend ceiling (ADR-0073, D1). */
	deferrals: v.optional(v.number()),
};

export const classifyThread = internalAction({
	args: classifyThreadArgs,
	handler: deferredHandler<ObjectType<typeof classifyThreadArgs>>(
		deferClassify,
		async (ctx, args) => {
			// One model budget for this action, from its start (ADR-0073).
			anchorActionDeadline(ctx);
			const context = await ctx.runQuery(internal.mail.needsReply.getThreadContext, {
				threadId: args.threadId,
			});
			if (!context) return;

			// Eligibility (live delivery, the ingest-only headers) was snapshotted
			// when delivery enqueued the message (`interpret/enqueue.ts`); a message
			// without a snapshot is skipped by the run and the baseline stands.
			const interpret = (messageId: Id<'mailMessages'>) =>
				runInterpretation(ctx, { source: { kind: 'mail', id: messageId } });
			const interpretDelivered = async (alreadyInterpreted?: Id<'mailMessages'>) => {
				if (args.interpretMessageId && args.interpretMessageId !== alreadyInterpreted) {
					await interpret(args.interpretMessageId);
				}
			};

			const evaluation = evaluateNeedsReplyCandidate({
				ownerAddresses: context.ownerAddresses,
				messages: context.messages,
				precedence: args.precedence,
				autoSubmitted: args.autoSubmitted,
				listId: args.listId,
			});

			if (!evaluation.candidate) {
				await ctx.runMutation(internal.mail.needsReply.applyResult, {
					threadId: args.threadId,
					expectedLatestMessageId: context.latestMessageId,
					needsReply: null,
				});
				// D10: with no reply to decide, the reader display may be the only
				// consumer left; then the message waits for the thread to be opened.
				if (args.interpretMessageId && (await isDeferredUntilOpen(ctx, args.interpretMessageId)))
					return;
				await interpretDelivered();
				return;
			}

			const latestInbound = context.messages[evaluation.latestInboundIndex];
			if (!latestInbound) {
				await interpretDelivered();
				return;
			}

			// Persist the deterministic candidate first — the interpretation below is
			// a refinement, and any failure in it must leave this baseline in place.
			// The thread stays pending until the refinement ends: if this run is
			// killed before then, the reconcile sweep runs it again.
			await ctx.runMutation(internal.mail.needsReply.applyResult, {
				threadId: args.threadId,
				expectedLatestMessageId: context.latestMessageId,
				needsReply: {
					messageId: latestInbound.messageId,
					source: 'heuristic',
					urgency: 'normal',
				},
				isBaseline: true,
			});

			// Never throws; a replayed run (the sweep, a retry) hands back the stored
			// projection instead of calling the model again. While the thread's
			// earlier deferred mail is still being read (D10), this classification
			// continues later and the thread stays pending (needsReplyGates.ts).
			const run = await runInterpretation(ctx, {
				source: { kind: 'mail', id: latestInbound.messageId },
				predecessors: 'caller_continues',
			});
			if (await continuesLater(ctx, run, args)) return;
			// A spend refusal anywhere in the run (the gate, the model call, a
			// verifier batch or a claim check) defers the whole classification
			// BEFORE its projection is applied: a projection from a run that could
			// not finish its checks must not settle the thread (D1). It stays
			// pending and runs again.
			if (isBudgetRefused(run)) throw new BudgetDeferral();
			const projection = usableProjection(run);
			const hasVerdict = projection
				? await applyProjection(ctx, {
						threadId: args.threadId,
						mailboxId: context.mailboxId,
						ownerUserId: context.ownerUserId,
						expectedLatestMessageId: context.latestMessageId,
						latestInbound: {
							messageId: latestInbound.messageId,
							fromAddress: latestInbound.fromAddress,
							hasCalendarInvite: latestInbound.hasCalendarInvite,
						},
						projection,
						transcript: context.transcript,
					})
				: false;

			await interpretDelivered(latestInbound.messageId);

			// Every outcome this run saw end without a verdict would only repeat on a
			// retry, so it ends the attempt here. Only a run that never gets this far
			// (killed, timed out) is left pending for the sweep.
			if (!hasVerdict) {
				await ctx.runMutation(internal.mail.needsReplyPending.settlePending, {
					threadId: args.threadId,
					expectedLatestMessageId: context.latestMessageId,
				});
			}
		}
	),
});

/**
 * The interpretation's verdict, written through `applyResult`: the server's
 * decision (`needsReplyResultOf`), plus the clarification when that decision
 * needs a reply. True when the verdict persisted.
 */
async function applyProjection(
	ctx: ActionCtx,
	args: {
		threadId: Id<'mailThreads'>;
		mailboxId: Id<'mailboxes'>;
		ownerUserId: string;
		expectedLatestMessageId?: Id<'mailMessages'>;
		latestInbound: LatestInbound;
		projection: NeedsReplyProjection;
		transcript: string;
	}
): Promise<boolean> {
	const { decision } = needsReplyResultOf(args.projection, args.latestInbound);
	// Clarification loop: only when the message genuinely needs a reply do we
	// spend the extra passes deciding whether a good reply is missing a fact
	// only the owner can supply, and only for a sender the screener lets into
	// the queue (L3): `applyResult` drops a held-out sender's result, the
	// clarification with it. Self-contained fail-soft (undefined on any
	// error), so a clarification failure never downgrades the verdict.
	const clarification =
		decision.needsReply && !(await isHeldOutByScreener(ctx, args))
			? await clarifyWithMemory(ctx, {
					ownerUserId: args.ownerUserId,
					transcript: args.transcript,
					fromAddress: args.latestInbound.fromAddress,
					threadId: args.threadId,
					root: rootRequest('postbox', args.latestInbound.messageId),
					subject: {
						kind: 'mail_message',
						mailMessageId: args.latestInbound.messageId,
						mailboxId: args.mailboxId,
					},
				})
			: undefined;
	// A throw here is a real fault (e.g. the result no longer matching the
	// applyResult validator), so log it and keep the heuristic flag. Only the
	// first line: a Convex validation error goes on to print the whole argument,
	// and that carries the ask summary and question text.
	try {
		await projectNeedsReply(ctx, {
			threadId: args.threadId,
			...(args.expectedLatestMessageId
				? { expectedLatestMessageId: args.expectedLatestMessageId }
				: {}),
			latestInbound: args.latestInbound,
			projection: args.projection,
			...(clarification ? { clarification } : {}),
		});
		return true;
	} catch (err) {
		logError(
			'[needsReplyClassify] applyResult failed:',
			err instanceof Error ? err.message.split('\n', 1)[0] : 'non-Error thrown'
		);
		return false;
	}
}

/**
 * {@link refineClarification} behind the Postbox AI gate (`ai` flag, advisory
 * budget, rate limit: the extra passes are model spend interpretation's own
 * gate did not cover), with ANSWER-MEMORY fills: any question a stored
 * standing answer (scoped to this sender's contact, or org-general) already
 * resolves stays on the card with `answer.source = 'memory'`, shown as "last
 * time", so a remembered answer is never used silently. Fail-soft: a refused
 * gate asks nothing; a failed memory lookup asks exactly as before.
 */
async function clarifyWithMemory(
	ctx: ActionCtx,
	opts: {
		/** Whose background AI bucket pays (#1380). */
		ownerUserId: string;
		transcript: string;
		fromAddress: string;
		threadId: Id<'mailThreads'>;
		root: LlmRootContext;
		subject: BundleSubject;
	}
): Promise<ClarificationFlag | undefined> {
	try {
		await ctx.runMutation(internal.mail.ai.gate.assertAiAllowed, {
			ownerUserId: opts.ownerUserId,
		});
	} catch (error) {
		rethrowAdmissionRefusal(error);
		return undefined;
	}
	const clarification = await refineClarification(ctx, {
		transcript: opts.transcript,
		fromAddress: opts.fromAddress,
		items: await slotItemsFor(ctx, opts.threadId),
		root: opts.root,
		subject: opts.subject,
	});
	if (!clarification || clarification.questions.length === 0) return clarification;
	try {
		const { fills } = await ctx.runMutation(internal.inbox.clarificationMemory.resolveFills, {
			fromAddress: opts.fromAddress,
			questions: clarification.questions.map((q) => ({
				id: q.id,
				slotType: q.slotType,
				text: q.text,
			})),
		});
		return {
			...clarification,
			questions: applyMemoryFills(clarification.questions, fills, Date.now()),
		};
	} catch (error) {
		rethrowAdmissionRefusal(error);
		return clarification; // ask as before
	}
}

/** The thread's open items, so each question can name the item it fills (SPEC §6). */
async function slotItemsFor(
	ctx: ActionCtx,
	threadId: Id<'mailThreads'>
): Promise<SlotItem<Id<'threadItems'>>[]> {
	try {
		const loaded = await ctx.runQuery(internal.mail.interpret.responsePlanDraft.loadForDraft, {
			threadRef: { kind: 'mail', id: threadId },
		});
		return slotItemsOf(loaded.items);
	} catch {
		return []; // questions without an item link, as before
	}
}

/**
 * Produce the starter reply for an answered clarification card, so it flips
 * from "Needs your input" to "Draft ready".
 *
 * Scheduled by `mail.needsReplyClarify.answerClarification`. Drafts through the
 * shared draft service with the knowledge recall tool, the same way the team
 * pipeline drafts after its clarification (see ./needsReplyDraft.ts). FAIL-SOFT:
 * any gate/model failure leaves the card with the answers recorded and no
 * starter draft — the plain "Draft reply" button still works.
 */
export const draftWithAnswers = internalAction({
	args: {
		threadId: v.id('mailThreads'),
		/** Who answered the card: the rate limit is theirs (#1380). */
		triggeredByUserId: v.optional(v.string()),
		deferrals: v.optional(v.number()),
	},
	handler: deferredHandler<{
		threadId: Id<'mailThreads'>;
		triggeredByUserId?: string;
		deferrals?: number;
	}>(deferDraft, async (ctx, args) => {
		anchorActionDeadline(ctx);
		await draftClarificationReply(ctx, {
			threadId: args.threadId,
			...(args.triggeredByUserId ? { triggeredByUserId: args.triggeredByUserId } : {}),
		});
	}),
});

function deferDraft(): DeferrableAction {
	return internal.mail.ai.needsReplyClassify.draftWithAnswers;
}
