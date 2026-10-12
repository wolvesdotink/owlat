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
 * FAIL-SOFT: any refusal or failure records a `failed` extraction, so the brief says
 * it is incomplete. Never deletes items, never reads as "nothing to do", never throws.
 * `runInterpretation` is the plain core the wiring calls inside its own actions
 * (needs-reply, the team context step); `interpretMessage` is its action.
 */

import { v } from 'convex/values';
import { internalAction, type ActionCtx } from '../../_generated/server';
import { internal } from '../../_generated/api';
import { resolveLanguageModel } from '../../lib/llmProvider';
import { runLlmObject } from '../../lib/llm/dispatch';
import { meterLlmCall } from '../../analytics/meteredSpend';
import { logWarn } from '../../lib/runtimeLog';
import type { InterpretMode } from '@owlat/shared/threadBrief';
import {
	interpretModeValidator,
	interpretationSourceValidator,
	type InterpretationSource,
} from '../../lib/validators/threadBrief';
import {
	INTERPRET_EXTRACTOR_VERSION,
	interpretOutputSchema,
	interpretOutputSchemaFor,
	type InterpretOutput,
} from './schema';
import { buildInterpretPromptParts, renderSegments } from './prompt';
import { cachedPromptInput } from '../../lib/llm/promptCacheInput';
import { predecessorRoot, predecessorsPending, runDeferredPredecessors } from './defer';
import {
	finish,
	type InterpretArgs,
	type InterpretRunResult,
	type Restart,
	type RunRecord,
} from './runShape';
import { groundProposals } from './ground';
import { isInterpretationEligible, isSecurityMail, isShortMail } from './eligibility';
import { contentRevisionOf, scopeForInterpretation, segmentScoped } from './scope';
import { buildInterpretInput, runStatusOf, toReduceResult, verifyClaimsOf } from './pipeline';
import { clampOutput } from './clamp';
import { needsReplyProjectionOf } from './needsReplyProjection';
import { interpretRoot, verifyClaims } from './verify';
import { isRetryDue } from './retry';
import type { ApplyOutcome } from './reduce';
import { guardAllowsInterpretation } from '../../agent/steps/security_scan/guard';
import { anchorActionDeadline } from '../../lib/llm/actionDeadline';
import { llmRootContextValidator } from '../../lib/llmUsageTags';

export type { InterpretArgs, InterpretRunResult } from './runShape';

export const INTERPRET_FEATURE = 'interpret';
/** Reducer attempts against a moving revision before the run gives up as partial. */
const MAX_APPLY_ATTEMPTS = 3;
/** Whole-run attempts when the body or the thread's mode changed under it. */
const MAX_RUN_ATTEMPTS = 2;

type Loaded = NonNullable<Awaited<ReturnType<typeof loadState>>>;

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

/** Interpret one message (see the module doc). Never throws. */
export async function runInterpretation(
	ctx: ActionCtx,
	args: InterpretArgs
): Promise<InterpretRunResult> {
	anchorActionDeadline(ctx); // one model budget per action, from here (ADR-0073)
	// D10: earlier deferred mail of the thread first, under the caller's deadline (defer.ts).
	const deadlineAt = args.root?.deadlineAt;
	const readFirst = (source: InterpretationSource) =>
		runInterpretation(ctx, {
			source,
			predecessors: 'already_read',
			...predecessorRoot(source, deadlineAt),
		});
	const pending = await runDeferredPredecessors(ctx, args.source, readFirst, args);
	if (pending) return predecessorsPending(pending);
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

async function runOnce(ctx: ActionCtx, args: InterpretArgs): Promise<InterpretRunResult | Restart> {
	const loaded = await loadState(ctx, args);
	if (!loaded) return { status: 'gone' };
	const mode: InterpretMode = loaded.mode;

	// A bulk-stranger candidate whose thread category is still provisional
	// (PR-4): wait for the category refinement, bounded, instead of deciding
	// the bulk rule on the baseline label. Only the deferral is recorded.
	if (loaded.categoryPendingUntil !== undefined) {
		// One deferred job per source and deadline (categoryDefer.ts).
		await ctx.runMutation(internal.mail.interpret.categoryDefer.deferForCategory, {
			source: args.source,
			until: loaded.categoryPendingUntil,
		});
		return {
			status: 'skipped',
			isReplayed: false,
			createdItemIds: [],
			errorCode: 'category_pending',
		};
	}

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

	// D13 (ADR-0073): a Team message whose scan skipped the model guard gets it
	// before this generative consumer; one it flags is not interpreted.
	if (!(await guardAllowsInterpretation(ctx, args.source, args.root?.deadlineAt))) {
		const skip = { skipReason: 'security' as const, errorCode: 'guard_flagged' };
		const record = { contentRevision: 'skip', status: 'skipped' as const, ...skip };
		return finish(await apply(ctx, args, loaded, record), { errorCode: skip.errorCode });
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
		// Admitted attempts (model calls) for this revision so far (round 4 M5):
		// gate refusals carry the count unchanged, every admitted attempt adds one.
		const priorAttempts = counted && isExact ? (counted.retryCount ?? 0) : 0;
		if (counted && isExact) {
			const isFinished = counted.status === 'complete' || counted.status === 'skipped';
			const isCurrentRead =
				loaded.current?.interpretationId === counted.interpretationId || !counted.hasPayload;
			if ((isFinished && isCurrentRead) || (!isFinished && !isRetryDue(counted, Date.now()))) {
				const good = loaded.current?.hasPayload ? loaded.current : null;
				// A reused result is an outcome: the source is no longer outstanding.
				await ctx.runMutation(internal.mail.interpret.outstanding.settleRecorded, {
					source: args.source,
				});
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
		}
		retryCount = priorAttempts + 1;
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
					// A refusal is not an admitted attempt: the count stays.
					retryCount: priorAttempts,
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
		const root = args.root ?? interpretRoot(args.source);
		// Spend admission (ADR-0073, D1): brief mode is background work, so its
		// holds stop at the advisory reserve like its gate; actions mode feeds
		// the Team pipeline.
		const priority = mode === 'brief' ? 'background' : 'pipeline';
		const model = await resolveLanguageModel(ctx, 'extract');
		const parts = buildInterpretPromptParts(input);
		const prompt = await cachedPromptInput(ctx, 'mail.extract', model, parts);
		const { object } = await meterLlmCall(
			ctx,
			{ feature: INTERPRET_FEATURE, root, priority },
			(meter) =>
				runLlmObject({
					meter,
					model,
					schema: interpretOutputSchemaFor(mode),
					...prompt,
					temperature: 0,
				}),
			// A lost ledger row under-counts; dropping the interpretation over it would be worse.
			{ onWriteError: 'ignore' }
		);

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
		const verified = await verifyClaims(ctx, claims, root, priority);

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
		root: v.optional(llmRootContextValidator),
	},
	handler: async (ctx, args): Promise<InterpretRunResult> => runInterpretation(ctx, args),
});
