'use node';

/**
 * `interpretMessage` (SPEC §4 `run.ts`): interpret one message and fold it
 * into its thread.
 *
 *   1. load      thread, mode, eligibility signals, brief revision, items, facts
 *   2. eligible? an ineligible message is recorded as skipped and stops here
 *   3. scope     signed-block scoping, undecryptable → skipped
 *   4. segment   `segmentMessage` (stable ids) → content revision
 *   5. dedupe    an applied extraction of this revision + extractor is reused
 *   6. gate      `ai` flag and the spend ceiling (`gate.ts`)
 *   7. model     `runLlmObject` on the `extract` tier, temperature 0, metered
 *                as `interpret`
 *   8. ground    every claim's quotes verbatim in the named segment
 *   9. verify    consequential claims on the `guard` tier (`verify.ts`)
 *  10. reduce    `applyInterpretation`, compare-and-set, retried when stale
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
import type { InterpretMode } from '@owlat/shared/threadBrief';
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
import {
	buildInterpretInput,
	clampOutput,
	runStatusOf,
	toReduceResult,
	verifyClaimsOf,
} from './pipeline';
import { needsReplyProjectionOf, type NeedsReplyProjection } from './needsReplyProjection';
import { verifyClaims } from './verify';
import type { ReduceResult } from './reduceInput';
import type { ApplyOutcome } from './reduce';

export const INTERPRET_FEATURE = 'interpret';
/** Reducer attempts against a moving revision before the run gives up as partial. */
const MAX_APPLY_ATTEMPTS = 3;

export interface InterpretArgs {
	source: InterpretationSource;
	/** Force a mode (scope conversion); default: the thread's own. */
	mode?: InterpretMode;
	/** Live delivery (default) vs backfill / APPEND. */
	isLive?: boolean;
	precedence?: string;
	listId?: string;
}

export type InterpretRunResult =
	| {
			status: 'complete' | 'partial' | 'failed' | 'skipped' | 'replayed';
			interpretationId?: Id<'messageInterpretations'>;
			createdItemIds: Id<'threadItems'>[];
			/** The Postbox needs-reply inputs, when the model read the message. */
			projection?: NeedsReplyProjection;
			errorCode?: string;
	  }
	/** The source or its thread is gone, or a purge ran meanwhile: nothing written. */
	| { status: 'gone' };

type Loaded = NonNullable<Awaited<ReturnType<typeof loadState>>>;

function loadState(ctx: ActionCtx, args: InterpretArgs) {
	return ctx.runQuery(internal.mail.interpret.load.loadForInterpretation, {
		source: args.source,
		...(args.isLive !== undefined ? { isLive: args.isLive } : {}),
		...(args.precedence ? { precedence: args.precedence } : {}),
		...(args.listId ? { listId: args.listId } : {}),
	});
}

/** Apply through the reducer, reloading the revision while it is stale. */
async function apply(
	ctx: ActionCtx,
	args: InterpretArgs,
	loaded: Loaded,
	mode: InterpretMode,
	record: {
		contentRevision: string;
		status: 'complete' | 'partial' | 'failed' | 'skipped';
		skipReason?: 'short' | 'bulk' | 'security' | 'undecryptable' | 'ineligible';
		errorCode?: string;
		sourceManifest?: Infer<typeof sourceManifestValidator>;
		coverage?: Infer<typeof interpretCoverageValidator>;
		result?: ReduceResult;
	}
): Promise<ApplyOutcome> {
	let state = loaded;
	let outcome: ApplyOutcome = { outcome: 'gone' };
	for (let attempt = 0; attempt < MAX_APPLY_ATTEMPTS; attempt++) {
		outcome = await ctx.runMutation(internal.mail.interpret.reduce.applyInterpretation, {
			source: args.source,
			threadRef: state.threadRef,
			mode,
			contentRevision: record.contentRevision,
			extractorVersion: INTERPRET_EXTRACTOR_VERSION,
			expectedRevision: state.brief.interpretationRevision,
			deletionEpoch: state.brief.deletionEpoch,
			sourceAt: state.sourceAt,
			direction: state.direction,
			status: record.status,
			...(record.skipReason ? { skipReason: record.skipReason } : {}),
			...(record.errorCode ? { errorCode: record.errorCode } : {}),
			eligibility: state.eligibility,
			...(record.sourceManifest ? { sourceManifest: record.sourceManifest } : {}),
			...(record.coverage ? { coverage: record.coverage } : {}),
			...(record.result ? { result: record.result } : {}),
			...(state.threadAssigneeUserId ? { threadAssigneeUserId: state.threadAssigneeUserId } : {}),
		});
		if (outcome.outcome !== 'stale') return outcome;
		const reloaded = await loadState(ctx, args);
		if (!reloaded) return { outcome: 'gone' };
		// A purge between the load and the write is not a retry: the content is gone.
		if (reloaded.brief.deletionEpoch !== state.brief.deletionEpoch) return { outcome: 'erased' };
		state = reloaded;
	}
	return outcome;
}

function finish(
	outcome: ApplyOutcome,
	status: 'complete' | 'partial' | 'failed' | 'skipped',
	extra: { projection?: NeedsReplyProjection; errorCode?: string } = {}
): InterpretRunResult {
	switch (outcome.outcome) {
		case 'gone':
		case 'erased':
			return { status: 'gone' };
		case 'stale':
			// The revision kept moving: nothing applied this time; the next message retries.
			return { status: 'failed', createdItemIds: [], errorCode: 'stale', ...extra };
		case 'applied':
		case 'replayed':
			return {
				status: outcome.outcome === 'replayed' ? 'replayed' : status,
				interpretationId: outcome.interpretationId,
				createdItemIds: outcome.createdItemIds,
				...extra,
			};
	}
}

/** Interpret one message (see the module doc). Never throws. */
export async function runInterpretation(
	ctx: ActionCtx,
	args: InterpretArgs
): Promise<InterpretRunResult> {
	const loaded = await loadState(ctx, args);
	if (!loaded) return { status: 'gone' };
	const mode: InterpretMode = args.mode ?? loaded.mode;

	const eligible = isInterpretationEligible(loaded.eligibility, { direction: loaded.direction });
	if (!eligible.isEligible) {
		const outcome = await apply(ctx, args, loaded, mode, {
			contentRevision: 'skip',
			status: 'skipped',
			skipReason: eligible.skipReason,
			errorCode: eligible.detail,
		});
		return finish(outcome, 'skipped');
	}

	let contentRevision = 'unread';
	try {
		const scoped = await scopeForInterpretation(ctx, args.source);
		if (!scoped) return { status: 'gone' };
		if (!scoped.ok) {
			const outcome = await apply(ctx, args, loaded, mode, {
				contentRevision: 'undecryptable',
				status: 'skipped',
				skipReason: 'undecryptable',
			});
			return finish(outcome, 'skipped');
		}
		const segmented = segmentScoped(scoped);
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

		// Dedupe: this revision was already folded in by an earlier run.
		const previous = loaded.previous.find(
			(p) =>
				p.contentRevision === contentRevision &&
				p.extractorVersion === INTERPRET_EXTRACTOR_VERSION &&
				p.isApplied &&
				(p.status === 'complete' || p.status === 'partial')
		);
		if (previous) {
			const stored = await ctx.runQuery(internal.mail.interpret.load.readStoredResult, {
				interpretationId: previous.interpretationId,
			});
			return {
				status: 'replayed',
				interpretationId: previous.interpretationId,
				createdItemIds: [],
				...(stored ? { projection: needsReplyProjectionOf(stored, loaded.ownerLocale) } : {}),
			};
		}

		const gate = await ctx.runQuery(internal.mail.interpret.gate.checkAllowed, { mode });
		if (!gate.isAllowed) {
			const outcome = await apply(ctx, args, loaded, mode, {
				contentRevision,
				status: 'failed',
				errorCode: gate.code,
				sourceManifest,
			});
			return finish(outcome, 'failed', { errorCode: gate.code });
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

		const itemText = new Map(loaded.openItems.map((i) => [i.id, i.assertion]));
		const factText = new Map(loaded.currentFacts.map((f) => [f.id, f.assertion]));
		const claims = verifyClaimsOf(grounding, segmented.canonicalText, {
			participants: loaded.participants,
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
			ownAddresses: new Set(loaded.ownAddresses),
			timezone: loaded.timezone,
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
		});
		const outcome = await apply(ctx, args, loaded, mode, {
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
		});
		return finish(outcome, run.status, {
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
			const outcome = await apply(ctx, args, loaded, mode, {
				contentRevision,
				status: 'failed',
				errorCode: 'model_error',
			});
			return finish(outcome, 'failed', { errorCode: 'model_error' });
		} catch {
			return { status: 'failed', createdItemIds: [], errorCode: 'model_error' };
		}
	}
}

/** The schedulable entry point (wiring: delivery, outbound lifecycle, team pipeline). */
export const interpretMessage = internalAction({
	args: {
		source: interpretationSourceValidator,
		mode: v.optional(interpretModeValidator),
		isLive: v.optional(v.boolean()),
		precedence: v.optional(v.string()),
		listId: v.optional(v.string()),
	},
	handler: async (ctx, args): Promise<InterpretRunResult> => runInterpretation(ctx, args),
});
