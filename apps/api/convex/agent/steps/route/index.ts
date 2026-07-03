/**
 * `route` Agent step (module) — see ADR-0014.
 *
 * Routes the agent's draft based on circuit-breaker safety, graduated
 * autonomy, and DRAFT-QUALITY scoring. The auto-approve threshold is compared
 * against the draft-quality self-check (`resolveAutoApproveScore`) — how
 * complete / grounded / on-tone the generated reply is — NOT the classifier's
 * confidence about the message category. The pipeline's last step — terminal in
 * both branches:
 *   - Auto-approve → approved (lifecycle's `schedule_send_approved` effect
 *     handles the actual send via `internal.agent.agentPipeline.sendApprovedReply`).
 *   - Otherwise → draft_ready (awaiting human review).
 *
 * The decision is made in three tiers, safest-first:
 *   1. Any open circuit breaker → human review (a degraded pipeline never
 *      auto-sends, regardless of config).
 *   2. Graduated autonomy (`ai.autonomy` flag on): the per-category
 *      `autonomyRules` govern via `autonomy.checkPermissionInternal`. A
 *      category with no rule is never auto-approved.
 *   3. Legacy fallback (`ai.autonomy` off): the single global
 *      `agentConfig` auto-reply toggle + draft-quality threshold + daily cap.
 *
 * In every tier the score compared against the threshold is the draft-quality
 * self-check, resolved LOW (never auto-approve) when that check is unknown.
 */

import { internal } from '../../../_generated/api';
import type { Id } from '../../../_generated/dataModel';
import type { AgentStepModule } from '../types';
import { detectInjection, INJECTION_CONFIDENCE_THRESHOLD } from '../security_scan/patterns';
import { detectSecretLeak } from '../../../lib/secretLeakScan';
import { deriveAuthenticatedRecipient } from '../../referenceMonitor';

/**
 * Draft-quality self-check threaded from the `draft` step. `null`/absent when
 * the self-check failed — {@link resolveAutoApproveScore} then treats quality as
 * unknown/LOW so the message is never auto-approved on an unknown draft.
 */
export type RouteDraftQuality = {
	score: number;
	complete: boolean;
	grounded: boolean;
	flags: string[];
};

export type RouteInput = {
	inboundMessageId: Id<'inboundMessages'>;
	confidence: number;
	category: string;
	// Draft-quality self-check from the draft step. Optional for back-compat:
	// a message routed without one (or with a failed self-check) is gated as
	// LOW quality — never auto-approved.
	draftQuality?: RouteDraftQuality | null;
};

/**
 * Resolve the score fed into the auto-approve threshold comparison.
 *
 * Auto-send must gate on whether the DRAFT is send-ready (complete, grounded,
 * on-tone) — NOT on the classifier's confidence about the message category,
 * which says nothing about draft correctness. When the draft-quality self-check
 * produced a score, that score is authoritative.
 *
 * FAIL-SOFT: when the self-check is absent (its LLM call failed → unknown
 * quality), fall back through the same confidence-threshold gate but with a LOW
 * score (0), so an unknown-quality draft can NEVER clear any threshold and is
 * always routed to human review. We never auto-approve on a failed/unknown
 * check.
 */
export function resolveAutoApproveScore(
	draftQuality: RouteDraftQuality | null | undefined,
): number {
	if (draftQuality && typeof draftQuality.score === 'number') {
		return draftQuality.score;
	}
	return 0;
}


/**
 * Final safety gate applied to EVERY auto-approval, after the autonomy tiers
 * have said "yes". Auto-send escapes the org boundary with no human in the loop,
 * so it must fail closed on three extra conditions:
 *   - the inbound guard-tier injection classifier couldn't run
 *     (`securityFlags.guardUnavailable`) — we never auto-send a message whose
 *     injection risk we couldn't assess; and
 *   - the generated draft itself trips an injection pattern — defense in depth
 *     against a partial prompt-injection success leaking into the reply; and
 *   - the draft contains a credential fingerprint (API key / private key) that
 *     would leak a secret past the org boundary unattended.
 * Any condition downgrades the decision to human review (the draft is still
 * produced and queued — only the autonomous send is withheld).
 *
 * IMPORTANT — this outbound scan is DEFENSE IN DEPTH, not the data-isolation
 * boundary. `detectInjection` only matches injection PHRASINGS; it does NOT
 * detect another contact's data bleeding into the reply. Cross-contact isolation
 * is enforced UPSTREAM by contact-scoped retrieval (lib/contactScope.ts +
 * knowledge/retrieval.ts + semanticFileProcessing.ts), so the assembled context
 * can't contain another contact's data in the first place. Do not weaken that
 * scoping on the assumption this gate will catch a leak — it won't.
 */
async function assertSafeToAutoSend(
	ctx: Parameters<AgentStepModule<'route', RouteInput, RouteOutput>['execute']>[0],
	inboundMessageId: Id<'inboundMessages'>,
): Promise<{ safe: true } | { safe: false; reason: string }> {
	const message = await ctx.runQuery(internal.agent.agentPipeline.getMessage, {
		inboundMessageId,
	});
	if (!message) return { safe: false, reason: 'Message not found before send — routing to human review.' };

	// Hard block: a draft produced from an ABANDONED clarification is a
	// best-guess (the owner never confirmed the missing facts). Never auto-send
	// it, regardless of autonomy tier or draft-quality score — a human must
	// review. Set by the abandoned-clarification fallback cron.
	if (message.autoSendBlocked) {
		return {
			safe: false,
			reason: 'Draft was produced from an abandoned clarification (best-guess); routing to human review.',
		};
	}

	if (message.securityFlags?.guardUnavailable) {
		return {
			safe: false,
			reason: 'Inbound injection guard was unavailable; not auto-sending — routing to human review.',
		};
	}

	// RECIPIENT LOCK — the auto-send target is derived SERVER-SIDE from the
	// authenticated inbound `From`; the model/draft can never supply or redirect
	// it. If that sender can't be resolved to an address, there is no
	// authenticated recipient to reply to unattended — fail closed.
	const recipient = deriveAuthenticatedRecipient(message.from ?? '');
	if (!recipient) {
		return {
			safe: false,
			reason: 'Could not derive an authenticated recipient from the inbound sender; not auto-sending — routing to human review.',
		};
	}

	const draft = message.draftResponse ?? '';
	const outbound = detectInjection(draft);
	if (outbound.detected && outbound.confidence >= INJECTION_CONFIDENCE_THRESHOLD) {
		return {
			safe: false,
			reason: `Outbound draft tripped an injection pattern (${outbound.pattern ?? 'unknown'}); not auto-sending — routing to human review.`,
		};
	}

	// A credential fingerprint in the draft (planted or hallucinated) would leak
	// a secret past the org boundary with no human in the loop. Fail closed to
	// human review, same posture as the injection check.
	const leak = detectSecretLeak(draft);
	if (leak.detected) {
		return {
			safe: false,
			reason: `Outbound draft contains a credential pattern (${leak.kind}); not auto-sending — routing to human review.`,
		};
	}

	return { safe: true };
}

export type RouteOutput = {
	decision: 'auto_approve' | 'human_review';
	reason: string;
	confidence: number;
	category: string;
};

export const routeStep: AgentStepModule<'route', RouteInput, RouteOutput> = {
	kind: 'route',

	async execute(ctx, input) {
		type Decision = { decision: 'auto_approve' | 'human_review'; reason: string };

		// The auto-approve threshold is compared against DRAFT quality, not the
		// classifier confidence. When the self-check is unknown/failed this is
		// LOW (0), so an unknown draft never clears any threshold (fail-soft to
		// human review). The autonomy tiers + assertSafeToAutoSend are unchanged;
		// this only swaps WHICH score feeds their threshold comparison.
		const gateScore = resolveAutoApproveScore(input.draftQuality);

		// Compute the routing decision + its precise reason. The tiers, order, and
		// safety gates are UNCHANGED — this only collects the outcome into one
		// value so the reason can be persisted alongside it (below) for the review
		// UI, without altering the decision itself.
		const decide = async (): Promise<Decision> => {
			// Auto-approval is only honoured if the final outbound safety gate
			// passes; otherwise it degrades to human review with the gate's reason.
			const autoApprove = async (reason: string): Promise<Decision> => {
				const gate = await assertSafeToAutoSend(ctx, input.inboundMessageId);
				return gate.safe
					? { decision: 'auto_approve', reason }
					: { decision: 'human_review', reason: gate.reason };
			};

			// Tier 1 — circuit-breaker safety gate. A pipeline with an open breaker
			// (LLM failures, confidence degradation, rejection spike) never
			// auto-sends; everything goes to human review until it recovers.
			const breakers = await ctx.runQuery(
				internal.agentHealth.getCircuitBreakersInternal,
				{},
			);
			const openBreaker = breakers.find((b) => b.state === 'open');
			if (openBreaker) {
				return { decision: 'human_review', reason: `Circuit breaker ${openBreaker.breakerType} is open — routing to human review.` };
			}

			// Tier 2 — graduated autonomy (per-category rules), when enabled.
			const autonomy = await ctx.runQuery(
				internal.autonomy.checkPermissionInternal,
				{ category: input.category, confidence: gateScore },
			);
			if (autonomy.mode === 'enabled') {
				if (autonomy.allowed) {
					// Apply the outbound safety gate BEFORE charging the daily cap, so
					// a withheld send doesn't consume an auto-reply slot.
					const gate = await assertSafeToAutoSend(ctx, input.inboundMessageId);
					if (!gate.safe) return { decision: 'human_review', reason: gate.reason };

					// Atomically charge the per-category daily cap. The query above is
					// advisory for the cap — `incrementDailyCount` is the authority and
					// re-checks it under a single serialized transaction, so two
					// concurrent route steps can't both auto-approve past the cap.
					// Route on its result.
					const charge = await ctx.runMutation(internal.autonomy.incrementDailyCount, {
						category: input.category,
					});
					if (charge.allowed) {
						return { decision: 'auto_approve', reason: autonomy.reason ?? `Per-category autonomy rule for ${input.category} permits auto-approval.` };
					}
					return { decision: 'human_review', reason: charge.reason ?? `Per-category autonomy denied for ${input.category}.` };
				}
				return { decision: 'human_review', reason: autonomy.reason ?? `Per-category autonomy denied for ${input.category}.` };
			}

			// Tier 3 — legacy global fallback (autonomy flag off).
			const cfg = await ctx.runQuery(
				internal.agent.agentPipeline.getAgentConfig,
				{},
			);

			if (cfg?.isAutoReplyEnabled && gateScore >= (cfg.confidenceThreshold ?? 0.8)) {
				const dailyCount = cfg.dailyAutoReplyCount ?? 0;
				const maxDaily = cfg.maxDailyAutoReplies ?? 100;
				const resetAt = cfg.dailyAutoReplyResetAt ?? 0;
				const isNewDay = Date.now() > resetAt;

				if (isNewDay || dailyCount < maxDaily) {
					return await autoApprove(`Draft quality ${gateScore} >= threshold ${cfg.confidenceThreshold}. Auto-approving.`);
				}
				return { decision: 'human_review', reason: `Daily auto-reply limit reached (${dailyCount}/${maxDaily}). Routing to human review.` };
			}

			return {
				decision: 'human_review',
				reason: cfg?.isAutoReplyEnabled
					? `Draft quality ${gateScore} < threshold ${cfg?.confidenceThreshold ?? 0.8}. Routing to human review.`
					: 'Auto-reply is disabled. Routing to human review.',
			};
		};

		const { decision, reason } = await decide();

		// Persist the decision + reason + confidence onto the inbound message so
		// the review UI can explain WHY ("Sent because… / Held because…"). This is
		// a READ-SIDE MIRROR of the decision the `route()` result already carries —
		// it changes NO routing. FAIL-SOFT: explainability is best-effort, so a
		// persistence failure must degrade to "no rationale shown" and never wedge
		// the walker or block the send/review transition.
		try {
			await ctx.runMutation(internal.inbox.processingLifecycle.recordAgentDecision, {
				inboundMessageId: input.inboundMessageId,
				decision,
				reason,
				confidence: input.confidence,
			});
		} catch {
			// swallowed: the routing decision below stands regardless
		}

		return { output: { decision, reason, confidence: input.confidence, category: input.category } };
	},

	route(output, _input, _runCtx) {
		if (output.decision === 'auto_approve') {
			return {
				kind: 'transition',
				transition: { to: 'approved', source: 'auto' },
			};
		}

		return {
			kind: 'transition',
			transition: { to: 'draft_ready' },
		};
	},
};
