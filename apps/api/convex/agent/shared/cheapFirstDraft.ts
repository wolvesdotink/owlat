'use node';

/**
 * The cheap-first writer (plan Phase 4, D2: reviewed drafts only).
 *
 * The caller chose it for a draft a person reviews whatever it says
 * (`lib/llm/complexity.ts` `classifiedDraftRoute`); the draft step also marks
 * the draft so it can never be auto-sent (`isCheapFirstDraft`, the
 * `cheap_first_draft` auto-send gate). Here:
 *
 *   1. The fast writer drafts, exactly as the default strategy does (tools,
 *      markup gate), and the host's quality check scores the draft.
 *   2. A draft that passes ({@link passesCheapFirst}) is kept.
 *   3. Otherwise, or when the fast pass failed, ONE escalation: the capable
 *      writer drafts once from the same grounding (the same context, plus the
 *      facts the fast pass looked up), without tools, and is checked. It is
 *      kept whatever its quality: the draft goes to a person either way.
 *   4. An escalation that fails leaves the fast draft for the owner's review.
 *
 * MONEY. The plan reserves the complete allowed path before dispatch. The
 * escalation is bounded up front (one request, a prompt of known size, the
 * task's output ceiling and attempts), so before the fast pass the writer
 * holds the escalation's worst case ({@link reserveEscalation}); the fast pass
 * is admitted request by request like every draft, against a headroom that
 * already counts the escalation. The escalation then runs under that hold
 * (its rows carry it, and the dispatch reserves nothing more), so it cannot be
 * refused after the fast pass was paid, and the hold is settled once against
 * its requests (none: released). A refused hold refuses the draft before any
 * spend (D1: the Team Inbox holds the message).
 *
 * Every request is metered once: the fast pass on its meter (written once its
 * quality is known, `qualityResult` `passed` or `escalated`, and on every
 * other exit), the escalation on its own (`passed`, `failed` or `abstained`),
 * under the fast pass as its parent call.
 */

import type { LanguageModel, ToolSet } from 'ai';
import type { ActionCtx } from '../../_generated/server';
import { internal } from '../../_generated/api';
import { meterFor, type LlmSpendTarget } from '../../analytics/meteredSpend';
import { reserveHold } from '../../analytics/admissionPorts';
import { runLlmText } from '../../lib/llm/dispatch';
import { callShape } from '../../lib/llm/callShape';
import { callDeadlineAt } from '../../lib/llm/actionDeadline';
import { LlmCallMeter, type LlmRootContext } from '../../lib/llm/requestMeter';
import { modelMaxOutputTokens } from '../../lib/llm/modelOutputLimits';
import { MAX_LLM_ATTEMPTS } from '../../lib/llm/retryPolicy';
import { taskPolicy } from '../../lib/llm/taskPolicy';
import { addTokenUsage } from '../../lib/llm/tokenUsage';
import { stripLeakedToolMarkup } from '../../lib/llm/toolMarkup';
import {
	admissionRefusalOf,
	dispatchHoldMicrousd,
	FALLBACK_OUTPUT_TOKENS,
	serializedBytes,
} from '../../lib/llm/admissionPort';
import type { QualityResult } from '../../lib/validators/aiRouting';
import { detectInjection, INJECTION_CONFIDENCE_THRESHOLD } from '../steps/security_scan/patterns';
import { markReviewerNotes } from './draftGaps';
import type { PrimaryDraft } from './draftMarkup';
import type { DraftQuality } from './draftSelfCheck';
import {
	checkDraft,
	draftChildRoot,
	draftMessages,
	draftSpendTarget,
	generatePrimary,
	recordAdvisorySpend,
	type CheapFirstWriter,
	type SharedDraftParams,
	type SharedDraftResult,
} from './draftGeneration';

const TASK = 'mail.draft' as const;

/** The quality a fast draft must reach to be kept without escalation (the default auto-send bar). */
export const CHEAP_FIRST_ACCEPT_SCORE = 0.8;

/** UTF-16 units of looked-up facts the escalation's prompt carries at most. */
export const ESCALATION_FACTS_UNITS = 12_000;
/** Serialized bytes one UTF-16 unit can take at most (`\uXXXX`). */
const MAX_BYTES_PER_UNIT = 6;
/** Provider parameters beside the messages (temperature, output ceiling, options). */
const REQUEST_PARAMS_BYTES = 1_024;
const FACTS_HEADING = '\n\n[Facts looked up while drafting this reply]\n';

/** Whether a fast draft's quality check lets it stand without escalation. */
export function passesCheapFirst(quality: DraftQuality | null): boolean {
	return (
		quality !== null &&
		quality.complete &&
		quality.grounded &&
		quality.score >= CHEAP_FIRST_ACCEPT_SCORE
	);
}

/** The ledger's quality result for a checked escalation. */
function escalationQuality(quality: DraftQuality | null): QualityResult {
	if (quality === null) return 'abstained';
	return passesCheapFirst(quality) ? 'passed' : 'failed';
}

/** The tool set with every result also recorded in `facts`, for the escalation's grounding. */
function recordingTools(tools: ToolSet, facts: string[]): ToolSet {
	const recorded: ToolSet = {};
	for (const [name, tool] of Object.entries(tools)) {
		const execute = tool.execute as ((input: unknown, options: unknown) => unknown) | undefined;
		recorded[name] = execute
			? {
					...tool,
					execute: async (input: unknown, options: unknown) => {
						const output: unknown = await execute(input, options);
						try {
							facts.push(`${name}: ${JSON.stringify(output)}`);
						} catch {
							// an output that cannot be serialized adds no grounding
						}
						return output;
					},
				}
			: tool;
	}
	return recorded;
}

/**
 * The escalation's context: the draft's own, plus what the fast pass looked
 * up (untrusted retrieved text, so it stays inside the untrusted block),
 * clamped to {@link ESCALATION_FACTS_UNITS}. Facts that read as an injection
 * attempt are left out.
 */
export function escalationContext(context: string, facts: readonly string[]): string {
	const looked = facts.join('\n').slice(0, ESCALATION_FACTS_UNITS);
	if (looked.trim().length === 0) return context;
	const injection = detectInjection(looked);
	if (injection.detected && injection.confidence >= INJECTION_CONFIDENCE_THRESHOLD) return context;
	return `${context}${FACTS_HEADING}${looked}`;
}

/** The escalation's hold, while the writer runs. */
interface EscalationHold {
	/** Spread into the escalation's spend target: it draws on this hold. */
	readonly target: Pick<LlmSpendTarget, 'reservationId' | 'requestId'>;
	/** Settle against the escalation's requests, or release when none was sent. Once. */
	settle(requests: number): Promise<void>;
}

const NO_HOLD: EscalationHold = Object.freeze({ target: {}, settle: async () => {} });

/**
 * Hold the escalation's worst case before the fast pass: its largest prompt
 * (the draft's messages plus the full facts allowance), the task's output
 * ceiling for the capable model, every attempt the task allows. Throws the
 * admission refusal (nothing is spent). No ceiling configured, or a local
 * model: nothing is held.
 */
export async function reserveEscalation(
	ctx: ActionCtx,
	params: SharedDraftParams,
	model: LanguageModel,
	root: LlmRootContext | undefined
): Promise<EscalationHold> {
	const shape = callShape({ model, meter: new LlmCallMeter({ task: TASK }) });
	if (shape.requestBase.isLocalEngine) return NO_HOLD;
	const largest = draftMessages({ ...params, context: `${params.context}${FACTS_HEADING}` }, false);
	const endpoint = shape.requestBase.endpoint;
	const bound = dispatchHoldMicrousd({
		modelId: shape.modelUsed,
		plane: 'language',
		...(endpoint ? { endpoint } : {}),
		bytes:
			serializedBytes(largest) + ESCALATION_FACTS_UNITS * MAX_BYTES_PER_UNIT + REQUEST_PARAMS_BYTES,
		messages: largest.length,
		outputTokens:
			shape.maxOutputTokens ?? modelMaxOutputTokens(shape.modelUsed) ?? FALLBACK_OUTPUT_TOKENS,
		steps: 1,
		attempts: shape.maxAttempts ?? MAX_LLM_ATTEMPTS,
		retries: 'every_step',
	});
	if (bound.microusd === 0) return NO_HOLD;
	// Each attempt of the escalation has its own bound, keyed by its request id.
	const requestId = globalThis.crypto.randomUUID();
	const [first, ...rest] = Array.from({ length: bound.maxRequests }, (_, index) => ({
		requestId,
		attempt: index + 1,
		microusd: bound.maxRequestMicrousd,
	}));
	if (!first) return NO_HOLD;
	const held = await reserveHold(ctx, {
		task: TASK,
		plane: 'language',
		budgetClass: taskPolicy(TASK).budgetClass,
		priority: taskPolicy(TASK).priority,
		root,
		microusd: bound.microusd,
		maxRequests: bound.maxRequests,
		requestBound: first,
		requestBounds: rest,
		modelId: shape.modelUsed,
		...(endpoint ? { endpoint } : {}),
		deadlineAt: callDeadlineAt(ctx, root),
	});
	if (!held) return NO_HOLD;
	const { reservationId } = held;
	let isSettled = false;
	return {
		target: { reservationId, requestId },
		settle: async (requests) => {
			if (isSettled) return;
			isSettled = true;
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

/** Write a draft call's rows with its quality result (never fails the draft). */
function writeRows(
	ctx: ActionCtx,
	target: LlmSpendTarget,
	meter: LlmCallMeter,
	qualityResult?: QualityResult
): Promise<void> {
	return recordAdvisorySpend(ctx, qualityResult ? { ...target, qualityResult } : target, meter);
}

/** The draft as the pipeline returns it, checked. */
async function checked(
	ctx: ActionCtx,
	params: SharedDraftParams,
	draft: PrimaryDraft,
	checkRoot: LlmRootContext | undefined
): Promise<SharedDraftResult> {
	const draftBody = markReviewerNotes(draft.draftBody);
	const check = await checkDraft(ctx, params, draftBody, checkRoot);
	return { draftBody, ...check, tokenUsage: draft.tokenUsage, modelUsed: draft.modelUsed };
}

/** Run the cheap-first writer (see the module comment). The injection re-scan already ran. */
export async function runCheapFirstDraft(
	ctx: ActionCtx,
	params: SharedDraftParams,
	writer: CheapFirstWriter
): Promise<SharedDraftResult> {
	const capable = await writer.resolveCapable();
	const facts: string[] = [];
	const fastTarget = draftSpendTarget(params);
	const fastMeter = meterFor(ctx, fastTarget);
	const escalationRoot = draftChildRoot(params, fastMeter);
	const hold = await reserveEscalation(ctx, params, capable, escalationRoot);
	let escalationMeter: LlmCallMeter | undefined;
	try {
		// 1. The fast pass, recording what its tools looked up.
		const tools = params.tools;
		const fastParams: SharedDraftParams = tools
			? {
					...params,
					tools: (draftCallRoot) =>
						recordingTools(typeof tools === 'function' ? tools(draftCallRoot) : tools, facts),
				}
			: params;
		let fast: PrimaryDraft | undefined;
		let isDefaultStrategy = false;
		let fastResult: SharedDraftResult | undefined;
		try {
			({ primary: fast, isDefaultStrategy } = await generatePrimary(
				ctx,
				fastParams,
				fastMeter,
				async () => {}
			));
			fastResult = await checked(ctx, params, fast, draftChildRoot(params, fastMeter));
		} catch (error) {
			// D1: a refusal is the caller's (the walker holds the message).
			if (admissionRefusalOf(error)) {
				await writeRows(ctx, fastTarget, fastMeter);
				throw error;
			}
		}
		// 2. A plugin strategy's draft, or a fast draft that passes, is kept.
		if (fastResult && (!isDefaultStrategy || passesCheapFirst(fastResult.draftQuality))) {
			await writeRows(ctx, fastTarget, fastMeter, isDefaultStrategy ? 'passed' : undefined);
			return fastResult;
		}
		await writeRows(ctx, fastTarget, fastMeter, fastResult ? 'escalated' : undefined);

		// 3. The one escalation, under the hold taken before the fast pass.
		const escalationTarget: LlmSpendTarget = {
			...fastTarget,
			...(escalationRoot ? { root: escalationRoot } : {}),
			...hold.target,
		};
		escalationMeter = meterFor(ctx, escalationTarget);
		let quality: QualityResult | undefined;
		try {
			const generated = await runLlmText({
				meter: escalationMeter,
				model: capable,
				messages: draftMessages(
					{ ...params, context: escalationContext(params.context, facts) },
					false
				),
				temperature: params.temperature ?? 0.4,
			});
			const text = stripLeakedToolMarkup(generated.text);
			if (generated.isTruncated === true || text.kind === 'unusable') {
				throw new Error('The escalated draft was unusable.');
			}
			const escalated = await checked(
				ctx,
				params,
				{
					draftBody: text.text,
					tokenUsage: addTokenUsage(fast?.tokenUsage, generated.tokenUsage),
					modelUsed: generated.modelUsed,
				},
				draftChildRoot(params, escalationMeter)
			);
			quality = escalationQuality(escalated.draftQuality);
			return escalated;
		} catch (error) {
			// 4. A failed escalation leaves the fast draft for the owner's review.
			if (admissionRefusalOf(error) || !fastResult) throw error;
			return fastResult;
		} finally {
			await writeRows(ctx, escalationTarget, escalationMeter, quality);
		}
	} finally {
		await hold.settle(escalationMeter?.requests.length ?? 0);
	}
}
