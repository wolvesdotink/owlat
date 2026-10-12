'use node';

/**
 * The steps of the shared draft service (`./draftService.ts` runs them once;
 * the cheap-first writer, `./cheapFirstDraft.ts`, runs the generation twice):
 * the parameters every drafting surface passes, the defense-in-depth
 * injection re-scan, the primary generation (a plugin strategy or the default
 * one, behind the markup gate), the streamed generation Answer mode watches,
 * and the host's quality check. Split out of `draftService.ts` so both stay
 * under the size cap and share one code path.
 */

import type { ToolSet, LanguageModel } from 'ai';
import {
	runLlmStream,
	runLlmText,
	runLlmTextWithTools,
	type LlmTextResult,
} from '../../lib/llm/dispatch';
import { withoutToolMarkup, type PrimaryDraft } from './draftMarkup';
import { LlmTruncatedError } from '../../lib/llm/truncation';
import { stripLeakedToolMarkup } from '../../lib/llm/toolMarkup';
import { addTokenUsage } from '../../lib/llm/tokenUsage';
import { meterFor, persistMeteredSpend, type LlmSpendTarget } from '../../analytics/meteredSpend';
import { markReviewerNotes } from './draftGaps';
import { childCall, type LlmCallMeter, type LlmRootContext } from '../../lib/llm/requestMeter';
import { detectInjection, INJECTION_CONFIDENCE_THRESHOLD } from '../steps/security_scan/patterns';
import type { ActionCtx } from '../../_generated/server';
import { runSelectedDraftStrategy } from './draftStrategyRunner';
import {
	runDraftSelfCheck,
	runPlanSelfCheck,
	type DraftQuality,
	type HeldSelfCheck,
} from './draftSelfCheck';
import {
	buildResponsePlanSection,
	parsePlanCheck,
	type AttachmentRef,
	type PlanPromptItem,
} from '../../mail/interpret/planCheck';
import type { PlanCoverage } from '../../mail/interpret/responsePlanRules';
import {
	buildDraftMessages,
	buildDraftSystemPrompt,
	type DraftClassificationBlock,
} from './draftPrompt';

/** Ctx shape the service needs — the spend-accounting surface. */
type SpendCtx = Parameters<typeof persistMeteredSpend>[0];

/**
 * A live view of the generation (Answer mode, `mail/ai/composeDraftWrite.ts`):
 * the text streams into the owner's buffer as the model writes it.
 */
export interface DraftStream {
	/** Aborts the stream when the owner stops it. */
	readonly signal: AbortSignal;
	/** The full text so far. */
	onText(full: string): Promise<void>;
	/** A tool call arrived: the text before it was dropped (`finalStepOnly`), show that now. */
	onToolCall(): Promise<void>;
	/** The first stream was markup: clear the view before the retry. */
	onRetry(): Promise<void>;
	/** The owner asked to stop. */
	readonly isStopRequested: () => boolean;
}

/**
 * The cheap-first writer (plan Phase 4, D2), chosen by the caller for a
 * REVIEWED draft only (`lib/llm/complexity.ts` `classifiedDraftRoute`):
 * `resolveModel` resolves the fast writer, and the one escalation runs on
 * `resolveCapable`.
 */
export interface CheapFirstWriter {
	readonly resolveCapable: () => Promise<LanguageModel>;
}

export type SharedDraftParams = Readonly<{
	/** Host surface identifier exposed to strategies instead of free-form audience text. */
	surface: 'organization' | 'personal';
	/** Resolve the host model only when the default or fallback strategy actually runs. */
	resolveModel: () => Promise<LanguageModel>;
	/** How the reply's audience is phrased in the system prompt ("an organization" / "the mailbox owner"). */
	audience: string;
	/** Whose communication style to match ("the organization's" / "the owner's"). */
	styleReference: string;
	/** Assembled untrusted context (thread history + trigger message). */
	context: string;
	/** TRUSTED owner-confirmed facts (clarification loop); rendered outside the untrusted tags. */
	confirmedContext?: string;
	/**
	 * TRUSTED stance/posture from a natural-language handling rule (e.g. "a polite
	 * decline"); rendered outside the untrusted tags as authoritative wording
	 * guidance. Absent on the normal path and on personal Postbox mail.
	 */
	stanceGuidance?: string;
	classification: DraftClassificationBlock;
	toneInstruction: string;
	signatureInstruction: string;
	voiceSection: string;
	/**
	 * Optional bounded recall tool set. Omit for personal mail. A function is
	 * given the draft call's own root (its parent call is the draft), for tools
	 * whose model calls group under the draft (Answer mode's recall).
	 */
	tools?: ToolSet | ((draftCallRoot: LlmRootContext) => ToolSet);
	/** Max agentic steps when a tool set is supplied. */
	maxSteps?: number;
	temperature?: number;
	/**
	 * Per-surface analytics labels so spend is attributable to the right surface.
	 * `draft` labels the primary generation, `selfCheck` the quality check.
	 * Without `selfCheck` no quality check runs: Answer mode's owner reviews
	 * the draft as it streams.
	 */
	spendLabels: Readonly<{ draft: string; selfCheck?: string }>;
	/**
	 * The inbound message the draft answers, as a root request (ADR-0073): the
	 * draft's and the self-check's ledger rows group under it.
	 */
	root?: LlmRootContext;
	/**
	 * ISO 639-1 code of the inbound's language (the classifier's `language`,
	 * already allowlisted by the caller). The reply is always written in the
	 * sender's language; naming it here makes the instruction explicit. Omit
	 * when unknown — the model then matches the inbound on its own.
	 */
	replyLanguage?: string;
	/**
	 * The response plan (SPEC §6): the items with their stances, rendered into
	 * the prompt, and the files the reply carries, for the self-check's claims.
	 * Plugin strategies do not see it; the host's self-check covers them too.
	 */
	responsePlan?: {
		items: readonly PlanPromptItem[];
		attachments: readonly AttachmentRef[];
	};
	/** Host-only deterministic selection hints. Omit to force the default strategy. */
	strategyScope?: {
		readonly mailboxId?: string;
		readonly contactId?: string;
		readonly classification: string;
	};
	/** Stream the generation into a live view (Answer mode). Default strategy only. */
	stream?: DraftStream;
	/** Write a reviewed draft cheap-first (D2). Absent: one generation on `resolveModel`. */
	writer?: CheapFirstWriter;
}>;

export type SharedDraftResult = Readonly<{
	draftBody: string;
	draftQuality: DraftQuality | null;
	/** The plan's coverage of the draft; null without a plan or when the check failed. */
	planCoverage: PlanCoverage | null;
	tokenUsage: LlmTextResult['tokenUsage'];
	modelUsed: LlmTextResult['modelUsed'];
}>;

/** The assembled context reads as a prompt-injection attempt: a person drafts this one. */
export class DraftInjectionError extends Error {
	constructor(pattern: string | undefined) {
		super(
			`Context contains prompt-injection pattern (pattern: ${pattern}); manual review required.`
		);
		this.name = 'DraftInjectionError';
	}
}

/** A streamed draft that stayed tool-call markup, or stopped at its output ceiling. */
export class DraftUnusableError extends Error {
	readonly reason: string;

	constructor(reason: string) {
		super(`Draft unusable: ${reason}`);
		this.name = 'DraftUnusableError';
		this.reason = reason;
	}
}

/**
 * Defense-in-depth: re-scan the fully-assembled context before it enters the
 * user role. The assembled context can include thread history not scanned
 * individually upstream.
 */
export function assertNoContextInjection(context: string): void {
	const injection = detectInjection(context);
	if (injection.detected && injection.confidence >= INJECTION_CONFIDENCE_THRESHOLD) {
		throw new DraftInjectionError(injection.pattern);
	}
}

/** The spend target of the draft generation. */
export function draftSpendTarget(params: SharedDraftParams): LlmSpendTarget {
	return { feature: params.spendLabels.draft, ...(params.root ? { root: params.root } : {}) };
}

/** Write the requests the meter holds; a failed ledger write never fails the draft. */
export async function recordAdvisorySpend(
	ctx: SpendCtx,
	target: LlmSpendTarget,
	meter: LlmCallMeter
): Promise<void> {
	try {
		await persistMeteredSpend(ctx, target, meter);
	} catch {
		// ignore — a lost row under-counts; failing the draft over it loses the work
	}
}

/** The root a call made for this draft runs under: the draft's call is its parent. */
export function draftChildRoot(
	params: SharedDraftParams,
	meter: LlmCallMeter
): LlmRootContext | undefined {
	return params.root ? childCall(params.root, meter.requestId) : undefined;
}

/**
 * The primary generation: the selected strategy (a plugin's or the default
 * one), then the markup gate (./draftMarkup.ts). Every request goes on
 * `meter`; the caller writes it on every exit. `isDefaultStrategy` says
 * whether the host's own writer produced the text. A streamed draft (Answer
 * mode) has no strategy scope and runs the default strategy streamed.
 */
export async function generatePrimary(
	ctx: ActionCtx,
	params: SharedDraftParams,
	meter: LlmCallMeter,
	record: () => Promise<void>
): Promise<{ primary: PrimaryDraft; isDefaultStrategy: boolean }> {
	if (params.stream) {
		return {
			primary: await streamDefaultDraft(params, params.stream, meter),
			isDefaultStrategy: true,
		};
	}
	let isDefaultStrategy = false;
	const selected = await runSelectedDraftStrategy(
		ctx,
		params.strategyScope,
		{
			audience: params.surface,
			context: params.context,
			confirmedContext: params.confirmedContext,
			stanceGuidance: params.stanceGuidance,
			classification: params.classification,
			toneInstruction: params.toneInstruction,
			signatureInstruction: params.signatureInstruction,
			voiceSection: params.voiceSection,
		},
		() => {
			isDefaultStrategy = true;
			return runDefaultDraftStrategy(params, true, meter);
		},
		// A plugin strategy's own model calls group under the message too.
		draftChildRoot(params, meter)
	);
	const primary = await withoutToolMarkup(
		selected,
		() => runDefaultDraftStrategy(params, false, meter),
		record
	);
	return { primary, isDefaultStrategy };
}

/**
 * The host's quality check of `draftBody`: the plan self-check when the draft
 * was written to a response plan, else the draft self-check. Fail-soft (null).
 * None without a `selfCheck` label. Host-owned: it runs for default and plugin
 * strategies alike, so a strategy cannot skip quality review.
 */
export async function checkDraft(
	ctx: ActionCtx,
	params: SharedDraftParams,
	draftBody: string,
	checkRoot: LlmRootContext | undefined,
	held?: HeldSelfCheck
): Promise<{ draftQuality: DraftQuality | null; planCoverage: PlanCoverage | null }> {
	const spendLabel = params.spendLabels.selfCheck;
	if (spendLabel === undefined) return { draftQuality: null, planCoverage: null };
	const plan = params.responsePlan;
	const common = {
		context: params.context,
		draft: draftBody,
		spendLabel,
		...(checkRoot ? { root: checkRoot } : {}),
		...(held ? { held } : {}),
	};
	if (!plan) return { draftQuality: await runDraftSelfCheck(ctx, common), planCoverage: null };
	const checked = await runPlanSelfCheck(ctx, { ...common, plan: plan.items });
	return {
		draftQuality: checked?.quality ?? null,
		planCoverage: checked
			? parsePlanCheck(checked.planCheck, {
					draft: draftBody,
					items: plan.items,
					attachments: plan.attachments,
				})
			: null,
	};
}

/** The draft's messages: the shared system prompt and message array. */
export function draftMessages(params: SharedDraftParams, hasRecallTool: boolean) {
	return buildDraftMessages({
		systemPrompt: buildDraftSystemPrompt({
			audience: params.audience,
			styleReference: params.styleReference,
			toneInstruction: params.toneInstruction,
			signatureInstruction: params.signatureInstruction,
			voiceSection: params.voiceSection,
			replyLanguage: params.replyLanguage,
			hasRecallTool,
		}),
		classification: params.classification,
		context: params.context,
		confirmedContext: params.confirmedContext,
		stanceGuidance: params.stanceGuidance,
		...(params.responsePlan
			? { responsePlan: buildResponsePlanSection(params.responsePlan.items) }
			: {}),
	});
}

/** The tool set of the draft call, given its own root. */
function draftTools(params: SharedDraftParams, meter: LlmCallMeter): ToolSet | undefined {
	return typeof params.tools === 'function'
		? params.tools(childCall(params.root, meter.requestId))
		: params.tools;
}

/**
 * Built-in `default` strategy; kept byte-for-byte equivalent to the old primary
 * path. `withTools: false` is the markup retry: no tool set, and a prompt that
 * names none.
 */
async function runDefaultDraftStrategy(
	params: SharedDraftParams,
	withTools: boolean,
	meter: LlmCallMeter
): Promise<LlmTextResult> {
	const tools = withTools ? draftTools(params, meter) : undefined;
	const model = await params.resolveModel();
	const messages = draftMessages(params, tools?.['recallKnowledge'] !== undefined);
	const temperature = params.temperature ?? 0.4;
	const generated =
		tools && Object.keys(tools).length > 0
			? await runLlmTextWithTools({
					meter,
					model,
					maxSteps: params.maxSteps,
					tools,
					messages,
					temperature,
				})
			: await runLlmText({ meter, model, messages, temperature });
	// A draft cut off at its output ceiling is not a draft: it fails like any
	// other failed generation (its requests are already on the meter).
	if (generated.isTruncated === true) throw new LlmTruncatedError('draft');
	return generated;
}

/**
 * The default strategy streamed into the owner's view (Answer mode). Tool-call
 * markup the model types instead of calling the tool (#1254) never reaches the
 * view as a reply: a stream that is markup is written once more without
 * tools, unless the owner stopped it. A draft that stays markup, or stopped
 * at its output ceiling, throws {@link DraftUnusableError}.
 */
async function streamDefaultDraft(
	params: SharedDraftParams,
	view: DraftStream,
	meter: LlmCallMeter
): Promise<PrimaryDraft> {
	const model = await params.resolveModel();
	const tools = draftTools(params, meter);
	const streamDraft = (withTools: boolean) =>
		runLlmStream({
			meter,
			model,
			messages: draftMessages(params, withTools && tools?.['recallKnowledge'] !== undefined),
			...(withTools && tools ? { tools, maxSteps: params.maxSteps } : {}),
			// The result is the draft body: narration before a tool call is not.
			finalStepOnly: true,
			temperature: params.temperature ?? 0.4,
			abortSignal: view.signal,
			onTextDelta: (full) => view.onText(full),
			// The text before the call was just dropped: clear it from the view now.
			onToolCall: () => view.onToolCall(),
		});
	let result = await streamDraft(true);
	let draft = stripLeakedToolMarkup(result.text);
	let tokenUsage = result.tokenUsage;
	if (draft.kind === 'unusable' && !result.aborted && !view.isStopRequested()) {
		// Typed-out tool markup, not a reply. Clear the view and write the draft
		// once more without the tool, by a prompt that names none.
		await view.onRetry();
		result = await streamDraft(false);
		draft = stripLeakedToolMarkup(result.text);
		tokenUsage = addTokenUsage(tokenUsage, result.tokenUsage);
	}
	// A draft cut off at its output ceiling is incomplete: it fails like markup.
	if (draft.kind === 'unusable') throw new DraftUnusableError(draft.reason);
	if (result.isTruncated === true) throw new DraftUnusableError('stopped at the output limit');
	return { draftBody: draft.text, tokenUsage, modelUsed: result.modelUsed };
}

/**
 * One generation and its quality check: the pipeline's usual path (and the
 * cheap-first writer's, when a plugin strategy is selected).
 */
export async function runSinglePassDraft(
	ctx: ActionCtx,
	params: SharedDraftParams
): Promise<SharedDraftResult> {
	// Every provider request of the primary generation is recorded in the
	// ledger exactly once, on every outcome: a throw after finished tool steps,
	// the rejected attempts of the markup gate (./draftMarkup.ts), or the
	// successful draft. Both generations (with tools, and the markup retry) run
	// on one meter, which hands each request out once, so flushing it on every
	// path cannot double-count. The successful draft's usage is also returned;
	// the Team Inbox walker keeps it on the step's agentActions row, a reporting
	// view the spend ceiling does not read (#1259). It is written before the
	// caller persists anything, so a write that fails after the generation
	// cannot lose it.
	const target = draftSpendTarget(params);
	const meter = meterFor(ctx, target);
	const recordDraftSpend = () => recordAdvisorySpend(ctx, target, meter);
	let primary: PrimaryDraft;
	try {
		({ primary } = await generatePrimary(ctx, params, meter, recordDraftSpend));
	} catch (error) {
		await recordDraftSpend();
		throw error;
	}
	await recordDraftSpend();
	// A reviewer note the model wrote anyway becomes a placeholder the send
	// guard counts (agent/shared/draftGaps.ts). A streamed draft keeps the text
	// the owner watched being written.
	const draftBody = params.stream ? primary.draftBody : markReviewerNotes(primary.draftBody);
	// The self-check judges this draft: it runs under the same root, the
	// generation as its parent call.
	const checked = await checkDraft(ctx, params, draftBody, draftChildRoot(params, meter));
	return {
		draftBody,
		...checked,
		tokenUsage: primary.tokenUsage,
		modelUsed: primary.modelUsed,
	};
}
