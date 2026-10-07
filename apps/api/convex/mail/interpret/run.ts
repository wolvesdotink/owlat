'use node';

/**
 * `interpretMessage` (SPEC §4 `run.ts`): interpret one message and fold it
 * into its thread.
 *
 *   1. load      thread, mode, the eligibility snapshot taken at enqueue
 *                (`sources.ts`; none → not interpreted), brief revision, items, facts
 *   2. eligible? an ineligible message is recorded as skipped and stops here
 *   3. scope     signed-block scoping, undecryptable → skipped; the body
 *                fingerprint the reducer rechecks
 *   4. segment   `segmentMessage` (stable ids) → content revision
 *   5. dedupe    an applied extraction of this revision + extractor is reused,
 *                unless it is incomplete and its retry is due (`retry.ts`)
 *   6. gate      `ai` flag and the spend ceiling (`gate.ts`)
 *   7. model     `runLlmObject` on the `extract` tier, temperature 0, metered
 *                as `interpret`
 *   8. ground    every claim's quotes verbatim in the named segment
 *   9. verify    consequential claims on the `guard` tier (`verify.ts`)
 *  10. reduce    `applyInterpretation`, compare-and-set, retried when stale;
 *                a changed body or mode starts the run over once
 *
 * FAIL-SOFT: a refusal or any failure records a `failed` extraction, so the
 * brief says it is incomplete; it never deletes items and never reads as
 * "nothing to do". Never throws.
 *
 * `runInterpretation` is the plain core the wiring calls inside its own
 * actions (the Postbox needs-reply classifier, the team context step);
 * `interpretMessage` is the schedulable internal action around it.
 */

import { v, type Infer } from 'convex/values';
import { internalAction, type ActionCtx } from '../../_generated/server';
import { internal } from '../../_generated/api';
import type { Id } from '../../_generated/dataModel';
import { resolveLanguageModel } from '../../lib/llmProvider';
import { runLlmObject } from '../../lib/llm/dispatch';
import { recordLlmSpend } from '../../analytics/llmUsage';
import { recordSpendOnFailure } from '../../analytics/failedLlmSpend';
import { logWarn } from '../../lib/runtimeLog';
import type { InterpretMode, InterpretationStatus } from '@owlat/shared/threadBrief';
import {
	interpretModeValidator,
	interpretationSourceValidator,
	type InterpretationSource,
	type interpretCoverageValidator,
	type sourceManifestValidator,
} from '../../lib/validators/threadBrief';
import {
	INTERPRET_EXTRACTOR_VERSION,
	interpretOutputSchema,
	interpretOutputSchemaFor,
	type InterpretOutput,
} from './schema';
import { buildInterpretPrompt, renderSegments } from './prompt';
import { groundProposals } from './ground';
import { isInterpretationEligible, isSecurityMail, isShortMail } from './eligibility';
import { contentRevisionOf, scopeForInterpretation, segmentScoped } from './scope';
import { buildInterpretInput, runStatusOf, toReduceResult, verifyClaimsOf } from './pipeline';
import { clampOutput } from './clamp';
import { needsReplyProjectionOf, type NeedsReplyProjection } from './needsReplyProjection';
import { verifyClaims } from './verify';
import { isGateCode, isRetryDue } from './retry';
import type { ReduceResult } from './reduceInput';
import type { ApplyOutcome } from './reduce';

export const INTERPRET_FEATURE = 'interpret';
/** Reducer attempts against a moving revision before the run gives up as partial. */
const MAX_APPLY_ATTEMPTS = 3;
/** Whole-run attempts when the body or the thread's mode changed under it. */
const MAX_RUN_ATTEMPTS = 2;

export interface InterpretArgs {
	source: InterpretationSource;
	/** Ignored: the mode is the thread's current one, rechecked by the reducer. */
	mode?: InterpretMode;
	/** Ignored: eligibility comes from the snapshot taken at enqueue (`sources.ts`). */
	isLive?: boolean;
	precedence?: string;
	listId?: string;
}

export type InterpretRunResult =
	| {
			/** The stored extraction's status, also when it was reused. */
			status: InterpretationStatus;
			/** The extraction was reused (dedupe or the reducer's replay check). */
			isReplayed: boolean;
			interpretationId?: Id<'messageInterpretations'>;
			createdItemIds: Id<'threadItems'>[];
			/** The Postbox needs-reply inputs, when the model read the message. */
			projection?: NeedsReplyProjection;
			errorCode?: string;
			/** An incomplete extraction will be repaired by a run at or after this time. */
			retryAt?: number;
	  }
	/** The source or its thread is gone, or a purge ran meanwhile: nothing written. */
	| { status: 'gone' };

type Loaded = NonNullable<Awaited<ReturnType<typeof loadState>>>;
type RunRecord = {
	contentRevision: string;
	status: InterpretationStatus;
	skipReason?: 'short' | 'bulk' | 'security' | 'undecryptable' | 'ineligible';
	errorCode?: string;
	sourceManifest?: Infer<typeof sourceManifestValidator>;
	coverage?: Infer<typeof interpretCoverageValidator>;
	result?: ReduceResult;
	sourceVersion?: string;
	retryCount?: number;
};

function loadState(ctx: ActionCtx, args: InterpretArgs) {
	return ctx.runQuery(internal.mail.interpret.load.loadForInterpretation, { source: args.source });
}

/** Apply through the reducer, reloading the revision while it is stale. */
async function apply(
	ctx: ActionCtx,
	args: InterpretArgs,
	loaded: Loaded,
	record: RunRecord
): Promise<ApplyOutcome> {
	let state = loaded;
	let outcome: ApplyOutcome = { outcome: 'gone' };
	for (let attempt = 0; attempt < MAX_APPLY_ATTEMPTS; attempt++) {
		outcome = await ctx.runMutation(internal.mail.interpret.reduce.applyInterpretation, {
			source: args.source,
			threadRef: state.threadRef,
			// The extraction is bound to the mode it was made in, whatever a reload says.
			mode: loaded.mode,
			contentRevision: record.contentRevision,
			extractorVersion: INTERPRET_EXTRACTOR_VERSION,
			expectedRevision: state.brief.interpretationRevision,
			deletionEpoch: state.brief.deletionEpoch,
			sourceAt: state.sourceAt,
			direction: state.direction,
			status: record.status,
			...(record.skipReason ? { skipReason: record.skipReason } : {}),
			...(record.errorCode ? { errorCode: record.errorCode } : {}),
			...(state.eligibility ? { eligibility: state.eligibility } : {}),
			...(record.sourceManifest ? { sourceManifest: record.sourceManifest } : {}),
			...(record.coverage ? { coverage: record.coverage } : {}),
			...(record.result ? { result: record.result } : {}),
			...(record.sourceVersion ? { sourceVersion: record.sourceVersion } : {}),
			...(record.retryCount !== undefined ? { retryCount: record.retryCount } : {}),
			...(state.threadAssigneeUserId ? { threadAssigneeUserId: state.threadAssigneeUserId } : {}),
		});
		if (outcome.outcome !== 'stale') return outcome;
		const reloaded = await loadState(ctx, args);
		if (!reloaded) return { outcome: 'gone' };
		// A purge between the load and the write is not a retry: the content is gone.
		if (reloaded.brief.deletionEpoch !== state.brief.deletionEpoch) return { outcome: 'erased' };
		// The scope changed: this extraction (its latest lines and facts, or their
		// absence) belongs to the old mode. Extract again.
		if (reloaded.mode !== loaded.mode) return { outcome: 'modeChanged' };
		state = reloaded;
	}
	return outcome;
}

/** The run's answer from the reducer's; `restart` when the run must start over. */
function finish(
	outcome: ApplyOutcome,
	extra: { projection?: NeedsReplyProjection; errorCode?: string } = {}
): InterpretRunResult | Restart {
	switch (outcome.outcome) {
		case 'gone':
		case 'erased':
			return { status: 'gone' };
		case 'modeChanged':
		case 'sourceChanged':
			return { restart: outcome.outcome };
		case 'stale':
			// The revision kept moving: nothing applied this time; the next message retries.
			return {
				status: 'failed',
				isReplayed: false,
				createdItemIds: [],
				...extra,
				errorCode: 'stale',
			};
		case 'applied':
		case 'replayed':
			return {
				status: outcome.status,
				isReplayed: outcome.outcome === 'replayed',
				interpretationId: outcome.interpretationId,
				createdItemIds: outcome.createdItemIds,
				...extra,
				...(outcome.nextRetryAt !== undefined ? { retryAt: outcome.nextRetryAt } : {}),
			};
	}
}

/** Interpret one message (see the module doc). Never throws. */
export async function runInterpretation(
	ctx: ActionCtx,
	args: InterpretArgs
): Promise<InterpretRunResult> {
	let reason: Restart['restart'] = 'sourceChanged';
	for (let attempt = 0; attempt < MAX_RUN_ATTEMPTS; attempt++) {
		const out = await runOnce(ctx, args);
		if (!('restart' in out)) return out;
		reason = out.restart;
	}
	// The body (or the scope) kept changing under every attempt: record that, with
	// no claims written, and keep the last good read (the reducer does).
	const errorCode = reason === 'sourceChanged' ? 'source_changed' : 'mode_changed';
	const loaded = await loadState(ctx, args);
	if (!loaded) return { status: 'gone' };
	const out = finish(
		await apply(ctx, args, loaded, { contentRevision: 'unread', status: 'failed', errorCode }),
		{ errorCode }
	);
	return 'restart' in out
		? { status: 'failed', isReplayed: false, createdItemIds: [], errorCode }
		: out;
}

/** The run must start over: the body or the thread's mode changed under it. */
type Restart = { restart: 'modeChanged' | 'sourceChanged' };

async function runOnce(ctx: ActionCtx, args: InterpretArgs): Promise<InterpretRunResult | Restart> {
	const loaded = await loadState(ctx, args);
	if (!loaded) return { status: 'gone' };
	const mode: InterpretMode = loaded.mode;

	const eligible = loaded.eligibility
		? isInterpretationEligible(loaded.eligibility, { direction: loaded.direction })
		: ({ isEligible: false, skipReason: 'ineligible', detail: 'no_snapshot' } as const);
	if (!eligible.isEligible) {
		return finish(
			await apply(ctx, args, loaded, {
				contentRevision: 'skip',
				status: 'skipped',
				skipReason: eligible.skipReason,
				errorCode: eligible.detail,
			}),
			{ errorCode: eligible.detail }
		);
	}

	let contentRevision = 'unread';
	let retryCount: number | undefined;
	try {
		const scoped = await scopeForInterpretation(ctx, args.source);
		if (!scoped) return { status: 'gone' };
		if (!scoped.ok) {
			return finish(
				await apply(ctx, args, loaded, {
					contentRevision: scoped.skipReason,
					status: 'skipped',
					skipReason: scoped.skipReason,
					...('detail' in scoped ? { errorCode: scoped.detail } : {}),
				}),
				'detail' in scoped ? { errorCode: scoped.detail } : {}
			);
		}
		// Every attempt is checked against the body it read (review round 2 F1).
		const sourceVersion = scoped.sourceVersion;
		const { segmented, isTruncated } = segmentScoped(scoped);
		contentRevision = await contentRevisionOf(segmented);
		const sourceManifest = {
			segments: segmented.segments.map((s) => ({
				id: s.id,
				kind: s.kind,
				start: s.start,
				end: s.end,
			})),
			isUncertain: segmented.uncertain,
		};

		// Reuse only on an EXACT match (review round 3 P3): the source's counted
		// extraction (its newest attempt) is for this content revision,
		// extractor version and mode. Then a complete one is reported as it
		// stands, an incomplete one is repaired once its retry is due. Anything
		// else (an older revision current again, another mode) re-extracts.
		const counted = loaded.counted;
		const isExact =
			!!counted &&
			counted.isApplied &&
			counted.contentRevision === contentRevision &&
			counted.extractorVersion === INTERPRET_EXTRACTOR_VERSION &&
			counted.mode === mode;
		let gateRetryCount: number | undefined;
		if (counted && isExact) {
			const isFinished = counted.status === 'complete' || counted.status === 'skipped';
			const isCurrentRead =
				loaded.current?.interpretationId === counted.interpretationId || !counted.hasPayload;
			if ((isFinished && isCurrentRead) || (!isFinished && !isRetryDue(counted, Date.now()))) {
				const good = loaded.current?.hasPayload ? loaded.current : null;
				const stored =
					good && good.contentRevision === contentRevision
						? await ctx.runQuery(internal.mail.interpret.load.readStoredResult, {
								interpretationId: good.interpretationId,
							})
						: null;
				return {
					status: counted.status,
					isReplayed: true,
					interpretationId: counted.interpretationId,
					createdItemIds: [],
					...(stored ? { projection: needsReplyProjectionOf(stored, loaded.ownerLocale) } : {}),
					...(counted.errorCode ? { errorCode: counted.errorCode } : {}),
					...(counted.nextRetryAt !== undefined ? { retryAt: counted.nextRetryAt } : {}),
				};
			}
			if (!isFinished) {
				// A gate refusal (AI off, budget) never spends the bounded retry budget.
				const prior = counted.retryCount ?? 0;
				retryCount = isGateCode(counted.errorCode) ? prior : prior + 1;
				gateRetryCount = prior;
			}
		}
		const attempt = {
			...(retryCount !== undefined ? { retryCount } : {}),
			...(sourceVersion ? { sourceVersion } : {}),
		};

		const gate = await ctx.runQuery(internal.mail.interpret.gate.checkAllowed, { mode });
		if (!gate.isAllowed) {
			return finish(
				await apply(ctx, args, loaded, {
					contentRevision,
					status: 'failed',
					errorCode: gate.code,
					sourceManifest,
					...(sourceVersion ? { sourceVersion } : {}),
					...(gateRetryCount !== undefined ? { retryCount: gateRetryCount } : {}),
				}),
				{ errorCode: gate.code }
			);
		}

		const input = buildInterpretInput({
			mode,
			segmented,
			sentAt: loaded.sourceAt,
			timezone: loaded.timezone,
			contentRevision,
			participants: loaded.participants,
			openItems: loaded.openItems,
			isItemsOverflow: loaded.isItemsOverflow,
			currentFacts: loaded.currentFacts,
			isFactsOverflow: loaded.isFactsOverflow,
			locales: loaded.locales,
		});
		const { truncatedSegmentIds } = renderSegments(input.message.segments);
		const { object, tokenUsage, modelUsed } = await recordSpendOnFailure(
			ctx,
			INTERPRET_FEATURE,
			runLlmObject({
				model: await resolveLanguageModel(ctx, 'extract'),
				schema: interpretOutputSchemaFor(mode),
				prompt: buildInterpretPrompt(input),
				temperature: 0,
			})
		);
		try {
			await recordLlmSpend(ctx, INTERPRET_FEATURE, tokenUsage, modelUsed);
		} catch {
			// A lost ledger row under-counts; dropping the interpretation over it would be worse.
		}

		// Validate with the lenient parse schema (the model schema only shapes the request).
		const output = clampOutput(interpretOutputSchema.parse(object) as InterpretOutput);
		const grounding = groundProposals(output, segmented);
		const ownAddresses = new Set(loaded.ownAddresses);

		const itemText = new Map(loaded.openItems.map((i) => [i.id, i.assertion]));
		const factText = new Map(loaded.currentFacts.map((f) => [f.id, f.assertion]));
		const claims = verifyClaimsOf(grounding, segmented.canonicalText, {
			participants: loaded.participants,
			ownAddresses,
			itemText: (id) => itemText.get(id),
			factText: (id) => factText.get(id),
		});
		const verified = await verifyClaims(ctx, claims);

		const freshText = segmented.segments
			.filter((s) => s.kind === 'fresh')
			.map((s) => segmented.canonicalText.slice(s.start, s.end))
			.join('\n');
		const latestSuppressed =
			mode !== 'brief'
				? undefined
				: isSecurityMail({ subject: scoped.subject, freshText })
					? ('security' as const)
					: isShortMail({
								freshChars: freshText.length,
								threadMessageCount: loaded.threadMessageCount,
						  })
						? ('short' as const)
						: undefined;

		const result = toReduceResult(output, grounding, {
			mode,
			canonicalText: segmented.canonicalText,
			participants: loaded.participants,
			ownAddresses,
			timezone: loaded.timezone,
			sentAt: loaded.sourceAt,
			verdicts: verified.verdicts,
			checked: new Set(claims.map((c) => c.id)),
			...(latestSuppressed ? { latestSuppressed } : {}),
		});
		const run = runStatusOf({
			grounding,
			output,
			isItemsOverflow: loaded.isItemsOverflow,
			isFactsOverflow: loaded.isFactsOverflow,
			truncatedSegmentIds,
			isVerifyIncomplete: verified.isIncomplete,
			isBodyIncomplete: scoped.omitted.includes('body_unavailable'),
			isBodyTruncated: isTruncated,
		});
		const outcome = await apply(ctx, args, loaded, {
			contentRevision,
			status: run.status,
			...(run.errorCode ? { errorCode: run.errorCode } : {}),
			sourceManifest,
			coverage: {
				segmentsRead: output.coverage.segmentsRead.slice(0, 50),
				isUncertain: output.coverage.uncertain,
				isOverflow: output.coverage.overflow,
			},
			result,
			...attempt,
		});
		return finish(outcome, {
			projection: needsReplyProjectionOf(result, loaded.ownerLocale),
			...(run.errorCode ? { errorCode: run.errorCode } : {}),
		});
	} catch (error) {
		// Only the first line: a validation error goes on to print its argument.
		logWarn(
			'[interpret] run failed:',
			error instanceof Error ? error.message.split('\n', 1)[0] : 'non-Error thrown'
		);
		try {
			return finish(
				await apply(ctx, args, loaded, {
					contentRevision,
					status: 'failed',
					errorCode: 'model_error',
					...(retryCount !== undefined ? { retryCount } : {}),
				}),
				{ errorCode: 'model_error' }
			);
		} catch {
			return { status: 'failed', isReplayed: false, createdItemIds: [], errorCode: 'model_error' };
		}
	}
}

/** The schedulable entry point (wiring: delivery, outbound lifecycle, team pipeline). */
export const interpretMessage = internalAction({
	args: {
		source: interpretationSourceValidator,
		// Accepted for older callers and ignored (see InterpretArgs).
		mode: v.optional(interpretModeValidator),
		isLive: v.optional(v.boolean()),
		precedence: v.optional(v.string()),
		listId: v.optional(v.string()),
	},
	handler: async (ctx, args): Promise<InterpretRunResult> => runInterpretation(ctx, args),
});
