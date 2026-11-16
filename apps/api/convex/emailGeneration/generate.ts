'use node';

/**
 * Draft an email with AI: a marketing template, a transactional email or a
 * whole campaign, from one sentence the author writes.
 *
 * One run reads, then calls the model once, then commits once:
 *   0. a submission that already committed is answered from its receipt
 *      (`receipts.lookup`), with no admission and no model call;
 *   1. read: the gate (flags and permission), the picked references, the
 *      style samples and the brand kit (`context.load`);
 *   2. admission: the `ai` flag, the spend budget and the
 *      `emailGenerationPerUser` bucket (`mail.ai.gate.assertAiAllowed`);
 *   3. one metered, schema-constrained model call;
 *   4. the outline mapped to editor blocks and validated (`blocksDecision.ts`);
 *   5. one commit (`commit.commit`) that re-checks the gate and the
 *      references, creates the draft through each table's own insert path and
 *      records the receipt, unless a run with the same request id beat it.
 *
 * The author waits for the result in the dialog. The run creates nothing
 * until its commit, so a run that fails, or that the author leaves, leaves
 * nothing half made; nothing is published, scheduled or sent.
 *
 * Not offered to the assistant as a tool: assistant tools may not write.
 */

import { ConvexError, v } from 'convex/values';
import { NoObjectGeneratedError } from 'ai';
import { generateId } from '@owlat/shared';
import { AI_BUDGET_ERROR_CODE } from '@owlat/shared/aiRouting';
import { internal } from '../_generated/api';
import type { ActionCtx } from '../_generated/server';
import { authedAction } from '../lib/authedFunctions';
import { requireAuthenticatedIdentity } from '../lib/sessionOrganization';
import { anchorActionDeadline } from '../lib/llm/actionDeadline';
import { runLlmObject } from '../lib/llm/dispatch';
import { newRootRequest } from '../lib/llm/requestMeter';
import { admissionRefusalOf } from '../lib/llm/admissionPort';
import { LlmTruncatedError } from '../lib/llm/truncation';
import { LlmPartialUsageError } from '../lib/llm/partialUsage';
import { meterLlmCall } from '../analytics/meteredSpend';
import { resolveLanguageModel } from '../lib/llmProvider';
import { AiNotConfiguredError } from '../lib/aiNotConfigured';
import { logWarn } from '../lib/runtimeLog';
import { throwForbidden, throwInvalidInput, throwInvalidState } from '../_utils/errors';
import { STRING_LIMITS } from '../lib/inputGuards';
import { generationKindValidator, referenceValidator } from './_helpers';
import { GENERATION_LIMITS, generatedEmailSchema, type GeneratedEmail } from './outputSchema';
import { planDraft, type DraftPlan, type GenerationKind } from './blocksDecision';
import { systemPrompt, userPrompt } from './promptDecision';
import { isValidRequestId } from './receipts';
import type { GenerationContext } from './context';
import type { GenerationOutcome } from './commit';

/** Stable codes the web maps to its own copy (`useEmailGeneration`). */
const CODES = {
	notConfigured: 'AI_NOT_CONFIGURED',
	invalidOutput: 'EMAIL_GENERATION_INVALID_OUTPUT',
	providerFailed: 'EMAIL_GENERATION_PROVIDER_FAILED',
} as const;

function assertRequest(args: {
	requestId: string;
	prompt: string;
	references: readonly unknown[];
	name?: string;
	slug?: string;
	defaultLanguage?: string;
}): void {
	if (!isValidRequestId(args.requestId)) throwInvalidInput('The request id is not valid');
	const prompt = args.prompt.trim();
	if (!prompt) throwInvalidInput('Describe the email you want');
	if (prompt.length > GENERATION_LIMITS.promptChars) {
		throwInvalidInput(`Keep the description under ${GENERATION_LIMITS.promptChars} characters`);
	}
	if (args.references.length > GENERATION_LIMITS.references) {
		throwInvalidInput(`Pick at most ${GENERATION_LIMITS.references} references`);
	}
	if ((args.name?.length ?? 0) > STRING_LIMITS.NAME) throwInvalidInput('The name is too long');
	if ((args.slug?.length ?? 0) > GENERATION_LIMITS.slugChars)
		throwInvalidInput('The slug is too long');
	if ((args.defaultLanguage?.length ?? 0) > 16) throwInvalidInput('Unknown language');
}

/** A model failure as the author reads it; a budget refusal keeps its code. */
function rethrowModelFailure(error: unknown): never {
	if (error instanceof ConvexError) throw error;
	const refusal = admissionRefusalOf(error);
	if (refusal) {
		throwForbidden('The AI budget is used up', {
			code: AI_BUDGET_ERROR_CODE,
			reason: refusal.reason,
			limit: refusal.limit,
		});
	}
	const cause = error instanceof LlmPartialUsageError ? error.cause : error;
	if (NoObjectGeneratedError.isInstance(cause) || cause instanceof LlmTruncatedError) {
		throwInvalidState('The AI wrote something that is not a usable email. Try again.', {
			code: CODES.invalidOutput,
		});
	}
	logWarn('[emailGeneration] model call failed', { error: String(error) });
	throwInvalidState('The AI provider did not answer. Try again in a moment.', {
		code: CODES.providerFailed,
	});
}

async function writeEmail(
	ctx: ActionCtx,
	kind: GenerationKind,
	prompt: string,
	language: string | null,
	context: GenerationContext
): Promise<GeneratedEmail> {
	let model;
	try {
		model = await resolveLanguageModel(ctx, 'email.generate');
	} catch (error) {
		if (error instanceof AiNotConfiguredError) {
			throwInvalidState('No AI provider is configured', { code: CODES.notConfigured });
		}
		throw error;
	}
	try {
		const { object } = await meterLlmCall(
			ctx,
			{ feature: 'email_generation', root: newRootRequest('email_generation') },
			(meter) =>
				runLlmObject({
					meter,
					model,
					schema: generatedEmailSchema,
					temperature: 0.6,
					messages: [
						{
							role: 'system',
							content: systemPrompt({ kind, language, companyName: context.companyName }),
						},
						{
							role: 'user',
							content: userPrompt({
								request: prompt,
								references: context.references,
								samples: context.samples,
							}),
						},
					],
				})
		);
		return object;
	} catch (error) {
		rethrowModelFailure(error);
	}
}

function draftFrom(
	email: GeneratedEmail,
	kind: GenerationKind,
	fallbackLanguage: string
): DraftPlan {
	const result = planDraft(email, {
		kind,
		fallbackLanguage,
		newId: () => generateId('block'),
	});
	if (!result.ok) {
		throwInvalidState('The AI wrote something that is not a usable email. Try again.', {
			code: CODES.invalidOutput,
			reason: result.reason,
		});
	}
	return result.plan;
}

export const generate = authedAction({
	args: {
		kind: generationKindValidator,
		/**
		 * One per submission, minted by the client and sent again only when it
		 * retries a submission whose outcome it never saw.
		 */
		requestId: v.string(),
		prompt: v.string(),
		references: v.array(referenceValidator),
		matchStyle: v.boolean(),
		/** The language the draft is written in; absent, the prompt's own. */
		defaultLanguage: v.optional(v.string()),
		/** Transactional: what the author already typed; the model fills what is blank. */
		name: v.optional(v.string()),
		slug: v.optional(v.string()),
	},
	// authz: context.load and commit.commit both check the kind's permissions
	// (templates:manage, plus campaigns:manage for a campaign) on the session.
	handler: async (ctx, args): Promise<GenerationOutcome> => {
		// One model budget for this action, from its start.
		anchorActionDeadline(ctx);
		await requireAuthenticatedIdentity(ctx);
		assertRequest(args);

		const recorded = await ctx.runQuery(internal.emailGeneration.receipts.lookup, {
			requestId: args.requestId,
		});
		if (recorded) return recorded;

		const context = await ctx.runQuery(internal.emailGeneration.context.load, {
			kind: args.kind,
			references: args.references,
			matchStyle: args.matchStyle,
		});
		// checkpoint: admission before the model call; the rate-limit token it
		// consumes stays spent when the draft fails later, so retries stay bounded.
		await ctx.runMutation(internal.mail.ai.gate.assertAiAllowed, {
			rateLimitBucket: 'emailGenerationPerUser',
		});

		const language = args.defaultLanguage?.trim() || null;
		const email = await writeEmail(ctx, args.kind, args.prompt.trim(), language, context);
		const plan = draftFrom(email, args.kind, language ?? 'en');

		const name = args.name?.trim() || plan.name;
		const slug = args.slug?.trim() || plan.slug || undefined;
		return await ctx.runMutation(internal.emailGeneration.commit.commit, {
			kind: args.kind,
			requestId: args.requestId,
			references: args.references,
			droppedVariables: plan.droppedVariables,
			name,
			subject: plan.subject,
			previewText: plan.previewText,
			language: language ?? plan.language,
			content: JSON.stringify(plan.blocks),
			...(args.kind === 'transactional'
				? {
						slug,
						isSlugSuggested: !args.slug?.trim(),
						dataVariablesSchema: plan.dataVariablesSchema ?? {},
						optionalDataVariables: plan.optionalDataVariables,
					}
				: {}),
		});
	},
});
