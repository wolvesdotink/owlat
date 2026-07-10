'use node';

/**
 * `draft` Agent step (module) — see ADR-0014.
 *
 * Generates a reply draft grounded in the organization's tone, signature,
 * and the assembled context. Uses the capable model tier. Defense-in-
 * depth: re-scans the assembled `context` for injection patterns before
 * letting it into the user role (the assembled context can include
 * thread history that wasn't individually scanned upstream).
 *
 * On injection-pattern detection in context: returns a `RouteTransition`
 * to `failed` via an error throw — the walker's catch translates to a
 * `to: 'failed'` lifecycle transition with `failingActionId`.
 */

import { internal } from '../../../_generated/api';
import { resolveLanguageModelForClassifiedDraft } from '../../../lib/llmProvider';
import { buildReplySubject } from '../../../lib/emailAddress';
import type { Id } from '../../../_generated/dataModel';
import type { AgentStepModule } from '../types';
import { buildRecallKnowledgeTool, MAX_RECALL_CALLS } from './recall';
import { draftAttachmentPatch } from './attachment';
import {
	ALLOWED_CATEGORIES,
	ALLOWED_INTENTS,
	ALLOWED_PRIORITIES,
	ALLOWED_SENTIMENTS,
	safeEnum,
} from './sanitize';
import {
	buildConfirmedContext,
	buildDraftOptionsPrompt,
	buildSelfCheckPrompt,
	draftQualitySchema,
	runSharedDraft,
	shouldOfferDraftOptions,
	type DraftQuality,
} from '../../shared/draftService';

// Re-exported from the shared draft service so existing imports (and unit tests)
// that reached into this step keep resolving after the extraction.
export {
	buildConfirmedContext,
	buildDraftOptionsPrompt,
	buildSelfCheckPrompt,
	draftQualitySchema,
	shouldOfferDraftOptions,
	type DraftQuality,
};

export type DraftInput = {
	inboundMessageId: Id<'inboundMessages'>;
	context: string;
	classification: {
		category: string;
		priority: string;
		sentiment: string;
		intent: string;
		confidence: number;
	};
	// TRUSTED facts the mailbox owner confirmed via the clarification loop
	// (`inbox.answerClarification`). Rendered as a `[CONFIRMED BY OWNER]` block
	// OUTSIDE the `<untrusted_email_content>` tags, so the model treats it as
	// authoritative instruction rather than data. Absent on the normal draft
	// path (no clarification was needed). See buildConfirmedContext.
	confirmedContext?: string;
};

export type DraftOutput = {
	draftResponse: string;
	draftSubject: string;
	confidenceScore: number;
	category: string;
	confidence: number;
	/** Draft-quality self-check (null when the check failed / was unknown). */
	draftQuality: DraftQuality | null;
	/**
	 * Alternative pickable drafts offered at the review gate (present only on
	 * low-confidence / low-quality cases; `draftOptions[0]` == `draftResponse`).
	 * Empty on the normal single-draft path and whenever options generation
	 * failed (fail-soft to the single draft).
	 */
	draftOptions: string[];
};

export const draftStep: AgentStepModule<'draft', DraftInput, DraftOutput> = {
	kind: 'draft',
	llm: { tier: 'capable' },

	async execute(ctx, input) {
		const agentConfig = await ctx.runQuery(internal.agent.agentPipeline.getAgentConfig, {});

		// Fetch the inbound message once — its recipient drives voice
		// personalization (below) and its subject drives the reply subject.
		const message = await ctx.runQuery(internal.agent.agentPipeline.getMessage, {
			inboundMessageId: input.inboundMessageId,
		});

		// Personalize to the recipient's learned writing voice when a Postbox
		// mailbox for this inbound recipient has opted in and has a derived
		// profile. Mirrors mail/ai.ts suggestReplies. OPTIONAL + FAIL-SOFT: no
		// recipient / no matching mailbox / personalization off / no profile /
		// accessor throws all collapse to exactly today's generic org tone.
		let voiceGuidance: string | null = null;
		if (message?.to) {
			try {
				const res = await ctx.runMutation(internal.mail.voiceProfile.getGuidanceForRecipient, {
					recipient: message.to,
				});
				voiceGuidance = res.guidance;
			} catch {
				voiceGuidance = null;
			}
		}
		const voiceSection = voiceGuidance ? `\n\n${voiceGuidance}` : '';

		// Sanitize classification fields against the allowlist before
		// interpolating into the system role.
		const safeCategory = safeEnum(input.classification.category, ALLOWED_CATEGORIES);
		const safeIntent = safeEnum(input.classification.intent, ALLOWED_INTENTS);
		const safeSentiment = safeEnum(input.classification.sentiment, ALLOWED_SENTIMENTS);
		const safePriority = safeEnum(input.classification.priority, ALLOWED_PRIORITIES);

		const toneInstruction = agentConfig?.toneDescription
			? `\n\nTone guidance: ${agentConfig.toneDescription}`
			: '\n\nTone: Professional and helpful. Use a friendly but concise style.';
		const signatureInstruction = agentConfig?.signatureTemplate
			? `\n\nEnd the email with this signature:\n${agentConfig.signatureTemplate}`
			: '';

		// Tier routing from TRUSTED classifier signals only (never the untrusted
		// email body): a clearly-trivial, high-confidence, low-stakes message may
		// draft on the fast tier when complexity routing is enabled. FAIL-SOFT:
		// routing off / any ambiguity keeps the capable tier — today's behaviour.
		const model = await resolveLanguageModelForClassifiedDraft(ctx, {
			category: safeCategory,
			intent: safeIntent,
			priority: safePriority,
			confidence: input.classification.confidence,
		});
		// Bounded, contact-scoped recall tool — lets the model FETCH a missing fact
		// mid-draft instead of hallucinating it. Same isolation gate as the context
		// step: scope to the inbound's contact, or org-general-only when there's no
		// resolved contact (never org-wide on the drafting path). FAIL-SOFT and
		// bounded (see recall.ts): retrieval errors ⇒ no facts; capped call count.
		const recallScope: Id<'contacts'> | 'org-general-only' =
			message?.contactId ?? 'org-general-only';
		const recallKnowledge = buildRecallKnowledgeTool({
			runAction: ctx.runAction,
			scopeToContact: recallScope,
		});

		// Natural-language handling rules — a matching `draft_with_stance` rule
		// ("draft a polite decline for recruiters") carries a user-authored STANCE
		// that must shape the wording of this reply. The rule text is trusted; the
		// deterministic engine already matched it against the message with no model
		// in the loop. Fold every matched stance into the draft as authoritative
		// posture guidance (rendered outside the untrusted tags in the shared
		// service). FAIL-SOFT: any failure evaluating the rules leaves the draft
		// exactly as today (no stance) — a stance is additive, never blocking.
		let stanceGuidance: string | undefined;
		try {
			const rules = await ctx.runQuery(internal.mail.handlingRules.evaluateForMessage, {
				inboundMessageId: input.inboundMessageId,
			});
			if (rules.stances.length > 0) {
				stanceGuidance = rules.stances.join('; ');
			}
		} catch {
			stanceGuidance = undefined;
		}

		// THE shared draft pipeline (agent/shared/draftService.ts): context
		// injection re-scan → primary generation (with the recall tool) → draft
		// self-check → gated multi-option review drafts. Personal Postbox
		// (mail/draftOnArrival.ts) runs the exact same service so both surfaces
		// produce identical output for the same inbound message.
		const { draftBody, draftQuality, draftOptions, tokenUsage, modelUsed } = await runSharedDraft(
			ctx,
			{
				model,
				audience: 'an organization',
				styleReference: "the organization's",
				context: input.context,
				confirmedContext: input.confirmedContext,
				stanceGuidance,
				classification: {
					category: safeCategory,
					intent: safeIntent,
					sentiment: safeSentiment,
					priority: safePriority,
				},
				toneInstruction,
				signatureInstruction,
				voiceSection,
				confidence: input.classification.confidence,
				// Allow a couple of fetch-more round-trips beyond the recall cap so the
				// model can act on what it fetched, then still produce the final draft.
				tools: { recallKnowledge },
				maxSteps: MAX_RECALL_CALLS + 2,
				spendLabels: { selfCheck: 'agent_draft_selfcheck', options: 'agent_draft_options' },
			}
		);

		// Compose the reply subject from the original (fetched above).
		const replySubject = buildReplySubject(message?.subject);

		// Persist the draft fields (in-state side effect — ADR-0010); the route
		// step reads them. The advisory, human-confirmed, contact-scoped attachment
		// suggestion (fail-soft — see ./attachment.ts) folds in as an optional patch.
		await ctx.runMutation(internal.inbox.stepOutputs.recordDraftOutput, {
			inboundMessageId: input.inboundMessageId,
			draftResponse: draftBody,
			draftSubject: replySubject,
			confidenceScore: input.classification.confidence,
			...(draftQuality ? { draftQuality } : {}),
			...(draftOptions.length > 0 ? { draftOptions } : {}),
			...(await draftAttachmentPatch(ctx, input.context, message?.contactId)),
		});

		return {
			output: {
				draftResponse: draftBody,
				draftSubject: replySubject,
				confidenceScore: input.classification.confidence,
				category: input.classification.category,
				confidence: input.classification.confidence,
				draftQuality,
				draftOptions,
			},
			tokenUsage,
			modelUsed,
		};
	},

	route(output, _input, runCtx) {
		// In-state — drafting state. Hand off to the route step, threading the
		// draft-quality self-check forward so the route step gates auto-send on
		// draft quality rather than classifier confidence.
		return {
			kind: 'in_state',
			nextStep: {
				kind: 'route',
				input: {
					inboundMessageId: runCtx.inboundMessageId,
					confidence: output.confidence,
					category: output.category,
					draftQuality: output.draftQuality,
				},
			},
		};
	},
};
