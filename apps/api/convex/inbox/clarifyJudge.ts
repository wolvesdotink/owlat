'use node';

/**
 * The shared clarification service: the slot
 * extraction and the judgment of which open slots must be asked, used by all
 * three surfaces. The surfaces keep what is theirs: Team Inbox
 * (`agent/steps/clarify`) parks the message, Postbox
 * (`mail/ai/needsReplyClassify.ts`) shows a Reply Queue card, and Answer mode
 * (`mail/ai/composeDraftGap.ts`) asks before drafting; each keeps its own
 * file questions, credential filtering, eagerness limits, localization and
 * answer memory.
 *
 * The judgment follows the `clarifyNecessity` routing switch:
 *
 * - `off` (the default, and the kill switch): today's check. Sample a few
 *   candidate replies and ask a judge which slots they fill differently; a
 *   slot they agree on is a safe assumption. Each surface keeps its own
 *   tiers and ledger features ({@link ClarifySurface}).
 * - `shadow`: today's check decides; the necessity judgment is asked beside
 *   it inside the D4 shadow allowance and stored with today's answer as its
 *   baseline. It never changes a question.
 * - `enforce` (D5): ONE necessity judgment replaces the samples and the
 *   judge, through the decisions lane's runner and artifact claim: one
 *   decision-plane call, or one fast-tier call on the language rung. If it is
 *   needed, every open slot becomes a question, in one batch (the surface caps
 *   it); if not, none does. Without an answer (no admission, the provider
 *   unavailable, another worker on the key) nothing is asked, exactly as when
 *   today's check fails. No sample and no capable-tier call is made.
 *
 * Accounting: each sample records under the task `mail.clarify_sample` with
 * its surface's feature, so the ledger counts samples and their cost apart from
 * the rest of `mail.clarify`; a necessity call records under `mail.necessity`.
 */

import type { LanguageModel } from 'ai';
import type { ActionCtx } from '../_generated/server';
import { internal } from '../_generated/api';
import type { AiTaskName } from '@owlat/shared/aiRouting';
import { resolveLanguageModel } from '../lib/llmProvider';
import type { LlmTier } from '../lib/llm/taskPolicy';
import { runLlmObject, runLlmText } from '../lib/llm/dispatch';
import type { LlmCallMeter, LlmRootContext } from '../lib/llm/requestMeter';
import { addTokenUsage } from '../lib/llm/tokenUsage';
import type { TokenUsage } from '../agent/steps/types';
import type { AdmissionPriority } from '../lib/validators/aiRouting';
import { planNecessity, type BundlePlan } from '../lib/decision/routing';
import { NECESSITY_BUNDLE } from '../lib/decision/bundles';
import { necessityState } from '../lib/decision/necessityState';
import { runBundle, type BundleSubject } from '../decision/bundleRunner';
import type { RoutingContext } from '../decision/context';
import {
	DIVERGENCE_SAMPLES,
	MIN_SAMPLES_FOR_JUDGMENT,
	buildCandidatePrompt,
	buildDivergencePrompt,
	buildSlotPrompt,
	divergenceSchema,
	replySlotsSchema,
	type ReplySlot,
	type SlotItem,
} from './clarificationSlots';

/** The task every sampled candidate reply records under. */
export const CLARIFY_SAMPLE_TASK = 'mail.clarify_sample' satisfies AiTaskName;

/** A stage's model: its catalog task, and the tier when the task runs on more than one. */
export interface ModelChoice {
	readonly task: AiTaskName;
	readonly tier?: LlmTier;
}

/** Resolve a stage's model: the one resolver call of the service (`resolverCallSites.test.ts`). */
function resolveStage(ctx: ActionCtx, choice: ModelChoice): Promise<LanguageModel> {
	return resolveLanguageModel(ctx, choice.task, choice);
}

/** One surface's way of asking: today's tiers, ledger features and metering. */
export interface ClarifySurface {
	readonly features: { readonly slots: string; readonly samples: string; readonly judge: string };
	/** The catalog task and tier each stage's model resolves for (`lib/llm/taskRouting.ts`). */
	readonly models: {
		readonly slots: ModelChoice;
		readonly samples: ModelChoice;
		readonly judge: ModelChoice;
	};
	/** A model the surface already resolved, used for every stage (Team). */
	readonly model?: LanguageModel;
	/**
	 * Resolve the sample model for each sample, inside that sample's failure
	 * boundary (Postbox, as before): a resolution that fails costs that one
	 * sample, and the later ones still run. Otherwise it is resolved once,
	 * before the samples, and a failure ends the check.
	 */
	readonly isSampleModelPerSample?: boolean;
	/** One metered call, the way the surface meters today. */
	readonly meter: <R>(
		feature: string,
		task: AiTaskName | undefined,
		call: (meter: LlmCallMeter) => Promise<R>
	) => Promise<R>;
	/** The message the necessity judgment is about; without one it cannot be asked. */
	readonly subject?: BundleSubject;
	readonly root: LlmRootContext;
	/** The master gate the claim checks when it is not the subject's default. */
	readonly masterGate?: 'ai' | 'ai.agent';
	/** The admission priority of the necessity call (Answer mode waits on it). */
	readonly priority?: AdmissionPriority;
	/** Sees every failed model call of the judgment; throwing from it rethrows. */
	readonly onCallError?: (error: unknown) => void;
}

export interface ExtractedSlots {
	readonly slots: readonly ReplySlot[];
	readonly tokenUsage?: TokenUsage;
	readonly modelUsed?: string;
}

/** Stage 1: the typed reply slots, each tied to the open item it fills. Throws on failure. */
export async function extractReplySlots(
	ctx: ActionCtx,
	surface: ClarifySurface,
	context: string,
	items: readonly SlotItem[]
): Promise<ExtractedSlots> {
	const model = surface.model ?? (await resolveStage(ctx, surface.models.slots));
	const result = await surface.meter(surface.features.slots, undefined, (meter) =>
		runLlmObject({
			meter,
			model,
			schema: replySlotsSchema,
			prompt: buildSlotPrompt(context, items),
			temperature: 0.2,
		})
	);
	return {
		slots: result.object.slots,
		...(result.tokenUsage ? { tokenUsage: result.tokenUsage } : {}),
		...(result.modelUsed ? { modelUsed: result.modelUsed } : {}),
	};
}

/** Which open slots must be asked. `keep` indexes into the candidates. */
export type SlotJudgment =
	| { readonly kind: 'divergence'; readonly keep: readonly number[] }
	| { readonly kind: 'insufficient_samples' }
	| { readonly kind: 'necessity'; readonly isNeeded: boolean }
	| { readonly kind: 'unjudged' };

export interface JudgedSlots {
	readonly judgment: SlotJudgment;
	/** The judgment's language usage the surface reports (samples with text, and the judge). */
	readonly tokenUsage?: TokenUsage;
}

/** The indexes the judgment keeps, over `count` candidates. */
export function keptIndexes(judgment: SlotJudgment, count: number): number[] {
	if (judgment.kind === 'divergence') return [...judgment.keep];
	if (judgment.kind === 'necessity' && judgment.isNeeded) {
		return Array.from({ length: count }, (_, index) => index);
	}
	return [];
}

/** The candidates the judgment keeps, in their own order, each once. */
export function keptSlots<S>(judgment: SlotJudgment, candidates: readonly S[]): S[] {
	const keep = new Set(keptIndexes(judgment, candidates.length));
	return candidates.filter((_, index) => keep.has(index));
}

/**
 * Stage 2: judge the open, relevant slots (`candidates`, non-empty). Throws
 * when today's judge call fails, as it did before; the surface decides what a
 * failure means for it.
 */
export async function judgeOpenSlots(
	ctx: ActionCtx,
	surface: ClarifySurface,
	context: string,
	candidates: readonly ReplySlot[]
): Promise<JudgedSlots> {
	const routing = await readRouting(ctx);
	const plan = routing ? planNecessity(routing.policy) : null;
	if (routing && plan?.mode === 'advisory') {
		const isNeeded = await askNecessity(ctx, surface, routing, plan, context);
		return {
			judgment: isNeeded === undefined ? { kind: 'unjudged' } : { kind: 'necessity', isNeeded },
		};
	}
	const sampled = await sampleDivergence(ctx, surface, context, candidates);
	if (routing && plan?.mode === 'shadow' && sampled.judgment.kind === 'divergence') {
		const baseline = keptSlots(sampled.judgment, candidates).length > 0 ? 'needed' : 'not_needed';
		await shadowNecessity(ctx, surface, routing, plan, context, baseline);
	}
	return sampled;
}

/** The routing policy and plane snapshot, or null (today's check) when it cannot be read. */
async function readRouting(ctx: ActionCtx): Promise<RoutingContext | null> {
	try {
		return await ctx.runQuery(internal.decision.context.routingContext, {});
	} catch {
		return null;
	}
}

/** Today's check: sampled candidate replies, then the divergence judge. */
async function sampleDivergence(
	ctx: ActionCtx,
	surface: ClarifySurface,
	context: string,
	candidates: readonly ReplySlot[]
): Promise<JudgedSlots> {
	const samples: string[] = [];
	let tokenUsage: TokenUsage | undefined;
	const sampleModelOnce =
		surface.model ??
		(surface.isSampleModelPerSample ? undefined : await resolveStage(ctx, surface.models.samples));
	for (let i = 0; i < DIVERGENCE_SAMPLES; i++) {
		try {
			const sampleModel = sampleModelOnce ?? (await resolveStage(ctx, surface.models.samples));
			const sample = await surface.meter(surface.features.samples, CLARIFY_SAMPLE_TASK, (meter) =>
				runLlmText({
					meter,
					model: sampleModel,
					prompt: buildCandidatePrompt(context),
					// High temperature so independent samples diverge where the answer is open.
					temperature: 0.9,
				})
			);
			if (sample.text.trim().length > 0) {
				samples.push(sample.text);
				tokenUsage = addTokenUsage(tokenUsage, sample.tokenUsage);
			}
		} catch (error) {
			surface.onCallError?.(error); // one failed sample does not end the check
		}
	}
	// Fewer than two candidates cannot disagree: no question is invented.
	if (samples.length < MIN_SAMPLES_FOR_JUDGMENT) {
		return { judgment: { kind: 'insufficient_samples' }, ...(tokenUsage ? { tokenUsage } : {}) };
	}
	const judgeModel = surface.model ?? (await resolveStage(ctx, surface.models.judge));
	const judged = await surface.meter(surface.features.judge, undefined, (meter) =>
		runLlmObject({
			meter,
			model: judgeModel,
			schema: divergenceSchema,
			prompt: buildDivergencePrompt([...candidates], samples),
			temperature: 0.1,
		})
	);
	tokenUsage = addTokenUsage(tokenUsage, judged.tokenUsage);
	return {
		judgment: { kind: 'divergence', keep: judged.object.divergentSlotIndexes },
		...(tokenUsage ? { tokenUsage } : {}),
	};
}

/** D5, enforced: whether the owner must be asked, or undefined without an answer. */
async function askNecessity(
	ctx: ActionCtx,
	surface: ClarifySurface,
	routing: RoutingContext,
	plan: BundlePlan,
	context: string
): Promise<boolean | undefined> {
	if (!surface.subject) return undefined;
	const outcome = await runBundle(ctx, {
		bundle: NECESSITY_BUNDLE,
		plan,
		routing,
		subject: surface.subject,
		built: necessityState(context),
		root: surface.root,
		...(surface.masterGate ? { masterGate: surface.masterGate } : {}),
		...(surface.priority ? { priority: surface.priority } : {}),
		...(surface.onCallError ? { onCallError: surface.onCallError } : {}),
	});
	const label = 'labels' in outcome ? outcome.labels?.['necessity'] : undefined;
	return label === 'needed' ? true : label === 'not_needed' ? false : undefined;
}

/** D5 in shadow: asked beside today's check, stored with its answer; never read here. */
async function shadowNecessity(
	ctx: ActionCtx,
	surface: ClarifySurface,
	routing: RoutingContext,
	plan: BundlePlan,
	context: string,
	baseline: 'needed' | 'not_needed'
): Promise<void> {
	if (!surface.subject) return;
	try {
		await runBundle(ctx, {
			bundle: NECESSITY_BUNDLE,
			plan,
			routing,
			subject: surface.subject,
			built: necessityState(context),
			root: surface.root,
			baseline: { necessity: baseline },
			...(surface.masterGate ? { masterGate: surface.masterGate } : {}),
		});
	} catch {
		// A shadow observation never changes clarification.
	}
}
