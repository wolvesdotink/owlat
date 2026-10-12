'use node';

/**
 * The cheap-first writer (plan Phase 4, D2: reviewed drafts only).
 *
 * The caller chose it for a draft a person reviews whatever it says
 * (`lib/llm/complexity.ts` `classifiedDraftRoute`); the draft step also marks
 * the draft so it can never be auto-sent (`isCheapFirstDraft`, the
 * `cheap_first_draft` auto-send gate). The path is four calls at most, all
 * without tools, so each one is bounded before anything is sent:
 *
 *   1. the fast writer drafts the reply (one generation, no markup retry);
 *   2. the host's quality check scores it;
 *   3. ONE escalation, only when the fast draft was unusable (tool-call
 *      markup, or cut off at its ceiling) or its check returned a verdict that
 *      does not pass ({@link failsCheapFirst}): the capable writer drafts once
 *      from the same messages;
 *   4. the quality check scores the escalated draft, which is kept whatever
 *      it says. A person reviews either draft.
 *
 * A provider failure is NOT a quality failure: the fast pass's error
 * (an authentication, configuration or transport failure) ends the writer
 * with that error, as it ends today's single pass, and buys no escalation.
 * An unknown verdict (the check failed, or the draft was too long to check)
 * keeps the fast draft for the owner's review. A failed escalation leaves the
 * usable fast draft.
 *
 * MONEY. The plan reserves the complete allowed path before dispatch. Before
 * the first call the writer holds the worst case of all four (each request's
 * exact prompt or its bounded maximum, the task's output ceiling, every
 * attempt the task allows; {@link reservePath}). Every call runs under that
 * one hold (its rows carry it; the dispatch reserves nothing more), so no
 * call can be refused after paid work, and the hold settles once against the
 * requests the path made (none: released). A refused hold refuses the draft
 * before any paid call (D1: the Team Inbox holds the message). With a plugin
 * strategy selected the writer is not cheap-first: the single pass runs.
 *
 * Every request is metered once, with its quality result: the fast draft
 * `passed` or `escalated`, the escalation `passed`, `failed` or `abstained`
 * (its parent call is the fast draft).
 */

import { zodSchema, type LanguageModel, type ModelMessage } from 'ai';
import type { ActionCtx } from '../../_generated/server';
import { internal } from '../../_generated/api';
import { meterFor, type LlmSpendTarget } from '../../analytics/meteredSpend';
import { reserveHold } from '../../analytics/admissionPorts';
import { resolveLanguageModel } from '../../lib/llmProvider';
import { runLlmText } from '../../lib/llm/dispatch';
import { callShape } from '../../lib/llm/callShape';
import { callDeadlineAt } from '../../lib/llm/actionDeadline';
import {
	childCall,
	LlmCallMeter,
	type LlmRootContext,
	type RequestBound,
} from '../../lib/llm/requestMeter';
import { modelMaxOutputTokens } from '../../lib/llm/modelOutputLimits';
import { MAX_LLM_ATTEMPTS } from '../../lib/llm/retryPolicy';
import { taskPolicy } from '../../lib/llm/taskPolicy';
import { addTokenUsage } from '../../lib/llm/tokenUsage';
import { stripLeakedToolMarkup } from '../../lib/llm/toolMarkup';
import type { AiTaskName } from '@owlat/shared/aiRouting';
import {
	dispatchHoldMicrousd,
	FALLBACK_OUTPUT_TOKENS,
	serializedBytes,
	utf8Bytes,
} from '../../lib/llm/admissionPort';
import type { QualityResult } from '../../lib/validators/aiRouting';
import { markReviewerNotes } from './draftGaps';
import { selectedDraftStrategy } from './draftStrategyRunner';
import {
	buildPlanSelfCheckPrompt,
	buildSelfCheckPrompt,
	draftQualitySchema,
	draftQualityWithPlanSchema,
	type DraftQuality,
} from './draftSelfCheck';
import {
	checkDraft,
	draftMessages,
	draftSpendTarget,
	recordAdvisorySpend,
	runSinglePassDraft,
	type CheapFirstWriter,
	type SharedDraftParams,
	type SharedDraftResult,
} from './draftGeneration';

const DRAFT_TASK = 'mail.draft' as const;
const CHECK_TASK = 'mail.draft_check' as const;

/** The quality a fast draft must reach to be kept without escalation (the default auto-send bar). */
export const CHEAP_FIRST_ACCEPT_SCORE = 0.8;

/**
 * UTF-8 bytes of a draft the quality check reads at most. The check's prompt
 * is the context, the plan and the draft, so this bounds it before the draft
 * exists. A longer draft is not checked (its quality is unknown).
 */
export const CHECKED_DRAFT_BYTES = 65_536;

/** Provider parameters beside the prompt (temperature, output ceiling, options). */
const REQUEST_PARAMS_BYTES = 1_024;

/** Whether a fast draft's verdict lets it stand without escalation. */
export function passesCheapFirst(quality: DraftQuality | null): boolean {
	return (
		quality !== null &&
		quality.complete &&
		quality.grounded &&
		quality.score >= CHEAP_FIRST_ACCEPT_SCORE
	);
}

/** Whether the check returned a verdict that the fast draft does not pass (unknown: no). */
export function failsCheapFirst(quality: DraftQuality | null): boolean {
	return quality !== null && !passesCheapFirst(quality);
}

/** The ledger's quality result for a checked escalation. */
function escalationQuality(quality: DraftQuality | null): QualityResult {
	if (quality === null) return 'abstained';
	return passesCheapFirst(quality) ? 'passed' : 'failed';
}

/** The calls of the path, each with its own request id and per-attempt bound. */
const PATH_CALLS = ['fastDraft', 'fastCheck', 'capableDraft', 'capableCheck'] as const;
type PathCall = (typeof PATH_CALLS)[number];

/** One call's worst case: every attempt its task allows, each at its output ceiling. */
function callBound(
	model: LanguageModel,
	task: AiTaskName,
	request: { readonly bytes: number; readonly messages: number }
) {
	const shape = callShape({ model, meter: new LlmCallMeter({ task }) });
	const endpoint = shape.requestBase.endpoint;
	const bound = shape.requestBase.isLocalEngine
		? { microusd: 0, maxRequests: 0, maxRequestMicrousd: 0 }
		: dispatchHoldMicrousd({
				modelId: shape.modelUsed,
				plane: 'language',
				...(endpoint ? { endpoint } : {}),
				bytes: request.bytes + REQUEST_PARAMS_BYTES,
				messages: request.messages,
				outputTokens:
					shape.maxOutputTokens ?? modelMaxOutputTokens(shape.modelUsed) ?? FALLBACK_OUTPUT_TOKENS,
				steps: 1,
				attempts: shape.maxAttempts ?? MAX_LLM_ATTEMPTS,
				retries: 'every_step',
			});
	return { ...bound, modelId: shape.modelUsed, ...(endpoint ? { endpoint } : {}) };
}

/** The largest quality-check request this draft's path can send. */
function checkRequestBytes(params: SharedDraftParams): number {
	const plan = params.responsePlan;
	const prompt = plan
		? buildPlanSelfCheckPrompt({ context: params.context, draft: '', plan: plan.items })
		: buildSelfCheckPrompt({ context: params.context, draft: '' });
	const schema = plan ? draftQualityWithPlanSchema : draftQualitySchema;
	return utf8Bytes(prompt) + CHECKED_DRAFT_BYTES + serializedBytes(zodSchema(schema).jsonSchema);
}

/** The path's hold, while the writer runs. */
export interface PathHold {
	/** Spread into a call's spend target: it draws on the hold under its own request id. */
	target(call: PathCall): Pick<LlmSpendTarget, 'reservationId' | 'requestId'>;
	/** Count a call's provider requests (its meter's, retries included). */
	count(requests: number): void;
	/** Settle against the counted requests, or release when none was sent. Once. */
	settle(): Promise<void>;
}

/**
 * Hold the worst case of the whole path before its first call, or throw the
 * admission refusal (nothing is spent). Every call gets its request id now,
 * so each attempt has its own bound on the hold. No ceiling configured, or
 * local models only: nothing is held, and the calls are admitted as usual.
 */
export async function reservePath(
	ctx: ActionCtx,
	params: SharedDraftParams,
	models: {
		readonly fast: LanguageModel;
		readonly capable: LanguageModel;
		readonly check: LanguageModel;
	},
	messages: readonly ModelMessage[]
): Promise<PathHold> {
	const draftRequest = { bytes: serializedBytes(messages), messages: messages.length };
	const checkRequest = { bytes: checkRequestBytes(params), messages: 1 };
	const bounds: Record<PathCall, ReturnType<typeof callBound>> = {
		fastDraft: callBound(models.fast, DRAFT_TASK, draftRequest),
		fastCheck: callBound(models.check, CHECK_TASK, checkRequest),
		capableDraft: callBound(models.capable, DRAFT_TASK, draftRequest),
		capableCheck: callBound(models.check, CHECK_TASK, checkRequest),
	};
	const requestIds = Object.fromEntries(
		PATH_CALLS.map((call) => [call, globalThis.crypto.randomUUID()])
	) as Record<PathCall, string>;
	const keyed: RequestBound[] = PATH_CALLS.flatMap((call) =>
		Array.from({ length: bounds[call].maxRequests }, (_, index) => ({
			requestId: requestIds[call],
			attempt: index + 1,
			microusd: bounds[call].maxRequestMicrousd,
		}))
	);
	const microusd = PATH_CALLS.reduce((total, call) => total + bounds[call].microusd, 0);
	const [first, ...rest] = keyed;
	const held =
		microusd > 0 && first
			? await reserveHold(ctx, {
					task: DRAFT_TASK,
					plane: 'language',
					budgetClass: taskPolicy(DRAFT_TASK).budgetClass,
					priority: taskPolicy(DRAFT_TASK).priority,
					root: params.root,
					microusd,
					maxRequests: keyed.length,
					requestBound: first,
					requestBounds: rest,
					modelId: bounds.capableDraft.modelId,
					...(bounds.capableDraft.endpoint ? { endpoint: bounds.capableDraft.endpoint } : {}),
					deadlineAt: callDeadlineAt(ctx, params.root),
				})
			: null;
	let requests = 0;
	let isSettled = false;
	return {
		target: (call) => ({
			requestId: requestIds[call],
			...(held ? { reservationId: held.reservationId } : {}),
		}),
		count: (n) => {
			requests += n;
		},
		settle: async () => {
			if (isSettled || !held) return;
			isSettled = true;
			const { reservationId } = held;
			// One ledger row per provider request: the hold settles once all are in.
			const done =
				requests === 0
					? ctx.runMutation(internal.aiRouting.admission.release, { reservationId })
					: ctx.runMutation(internal.aiRouting.admission.settle, {
							reservationId,
							expectedRequests: requests,
						});
			await done.catch(() => undefined);
		},
	};
}

/** A generation of the path: its meter, and the usable draft if there is one. */
interface Generated {
	readonly meter: LlmCallMeter;
	readonly target: LlmSpendTarget;
	readonly draft: { draftBody: string; tokenUsage: SharedDraftResult['tokenUsage'] } | null;
	readonly modelUsed: string | undefined;
}

/** Run the cheap-first writer (see the module comment). The injection re-scan already ran. */
export async function runCheapFirstDraft(
	ctx: ActionCtx,
	params: SharedDraftParams,
	writer: CheapFirstWriter
): Promise<SharedDraftResult> {
	// A plugin strategy writes with its own model and reservation: not cheap-first.
	if ((await selectedDraftStrategy(ctx, params.strategyScope)) !== 'default') {
		return runSinglePassDraft(ctx, params);
	}
	// Resolving first: a configuration failure ends the writer before any hold or call.
	const models = {
		fast: await params.resolveModel(),
		capable: await writer.resolveCapable(),
		check: await resolveLanguageModel(ctx, CHECK_TASK),
	};
	// No tools on either draft: the grounding both share is the draft's own
	// messages, which is what keeps every request of the path bounded.
	const messages = draftMessages(params, false);
	const hold = await reservePath(ctx, params, models, messages);
	const unwritten = new Map<LlmCallMeter, LlmSpendTarget>();
	const writeRows = async (meter: LlmCallMeter, quality?: QualityResult) => {
		const target = unwritten.get(meter);
		if (!target) return;
		unwritten.delete(meter);
		hold.count(meter.requests.length);
		await recordAdvisorySpend(ctx, quality ? { ...target, qualityResult: quality } : target, meter);
	};
	const generate = async (
		model: LanguageModel,
		call: 'fastDraft' | 'capableDraft',
		root: LlmRootContext | undefined
	): Promise<Generated> => {
		const target: LlmSpendTarget = {
			...draftSpendTarget(params),
			...(root ? { root } : {}),
			...hold.target(call),
		};
		const meter = meterFor(ctx, target);
		unwritten.set(meter, target);
		const generated = await runLlmText({
			meter,
			model,
			messages,
			temperature: params.temperature ?? 0.4,
		});
		const text = stripLeakedToolMarkup(generated.text);
		const isUsable = generated.isTruncated !== true && text.kind !== 'unusable';
		return {
			meter,
			target,
			modelUsed: generated.modelUsed,
			draft: isUsable
				? { draftBody: markReviewerNotes(text.text), tokenUsage: generated.tokenUsage }
				: null,
		};
	};
	/** A call made for `parent`'s output groups under the draft's root, `parent` its parent call. */
	const under = (parent: LlmCallMeter) =>
		params.root ? childCall(params.root, parent.requestId) : undefined;
	const check = (draftBody: string, call: 'fastCheck' | 'capableCheck', parent: LlmCallMeter) =>
		utf8Bytes(draftBody) > CHECKED_DRAFT_BYTES
			? Promise.resolve({ draftQuality: null, planCoverage: null })
			: checkDraft(ctx, params, draftBody, under(parent), {
					model: models.check,
					target: hold.target(call),
					onRequests: hold.count,
				});

	try {
		// 1–2. The fast draft and its verdict. A provider failure ends the writer.
		const fast = await generate(models.fast, 'fastDraft', params.root);
		let fastResult: SharedDraftResult | null = null;
		if (fast.draft) {
			fastResult = {
				...fast.draft,
				...(await check(fast.draft.draftBody, 'fastCheck', fast.meter)),
				modelUsed: fast.modelUsed,
			};
		}
		if (fastResult && !failsCheapFirst(fastResult.draftQuality)) {
			await writeRows(fast.meter, fastResult.draftQuality ? 'passed' : undefined);
			return fastResult;
		}
		await writeRows(fast.meter, 'escalated');

		// 3–4. The one escalation, under the same hold.
		let capable: Generated;
		try {
			capable = await generate(models.capable, 'capableDraft', under(fast.meter));
		} catch (error) {
			// A failed escalation leaves the usable fast draft for the owner's review.
			if (fastResult) return fastResult;
			throw error;
		}
		if (!capable.draft) {
			if (fastResult) return fastResult;
			throw new Error('Draft generation returned an unusable draft twice.');
		}
		const checked = await check(capable.draft.draftBody, 'capableCheck', capable.meter);
		await writeRows(capable.meter, escalationQuality(checked.draftQuality));
		return {
			draftBody: capable.draft.draftBody,
			...checked,
			tokenUsage: addTokenUsage(fast.draft?.tokenUsage, capable.draft.tokenUsage),
			modelUsed: capable.modelUsed,
		};
	} finally {
		// Every request is written once, on every exit, before the hold settles.
		for (const meter of [...unwritten.keys()]) await writeRows(meter);
		await hold.settle();
	}
}
