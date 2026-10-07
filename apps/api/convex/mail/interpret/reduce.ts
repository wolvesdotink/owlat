/**
 * `applyInterpretation` (SPEC §4 `reduce.ts`): fold one message's grounded,
 * verified interpretation into its thread, in ONE transaction:
 *
 *   1. recheck, against the database as it is now, everything the run assumed:
 *      the source still sits in this thread; the thread's mode (a mailbox
 *      converted to shared runs in actions mode; the cached brief mode is
 *      reconciled); no purge ran (`deletionEpoch`); the body the run read is
 *      the body stored now (`sourceVersion`). A mismatch writes nothing of the
 *      run and tells it to start over (`modeChanged`, `sourceChanged`);
 *   2. compare-and-set on `threadBriefs.interpretationRevision` (`stale` →
 *      the run re-applies the same extraction against the new state);
 *   3. store the extraction (one row per source, content revision and
 *      extractor version; the newest applied one per source is `isCurrent`)
 *      and move the source counters;
 *   4. fold it in: incrementally when it is the newest message and the first
 *      extraction of its source; otherwise (a late message, a repair, an
 *      edited body) by REPLAYING the thread's extractions in message order
 *      and re-applying human and recorded changes (`replay.ts`). A replay over
 *      budget falls back to the incremental rule and marks the run partial;
 *   5. write the difference with activity and item counters (`reduceWrite.ts`);
 *   6. bump the brief row (revision, checkpoint, completeness from the
 *      counters) and refresh the list-row projection.
 */

import type { Doc, Id } from '../../_generated/dataModel';
import type { MutationCtx } from '../../_generated/server';
import { internalMutation } from '../../lib/writeFence';
import type { BriefCompleteness, InterpretationStatus } from '@owlat/shared/threadBrief';
import { interpretationSourceKey } from '../../lib/validators/threadBrief';
import { rowMatchesThreadRef, threadRefToFields } from '../../lib/validators/threadRef';
import { sealBodyAtWrite } from '../../lib/messageBody';
import { INTERPRET_PAYLOAD_VERSION } from './schema';
import { ensureBriefRow, resolveThreadMode } from './briefRow';
import { exactWordingFieldsOf, RETIRED_EXACT_WORDING } from './exactWording';
import { appendActivity } from './activity';
import { applyInterpretationArgs } from './reduceInput';
import {
	briefTopLatestOf,
	loadIncrementalState,
	loadReplayState,
	sourceStillInThread,
} from './reduceState';
import { applyHumanOps, foldEntry, replayThread } from './replay';
import { writeState } from './reduceWrite';
import { EMPTY_SOURCE_COUNTS, completenessOfCounts, shiftCount, sourceBucketOf } from './counters';
import { nextRetryAtOf } from './retry';
import { sourceVersionOf } from './sourceVersion';
import { refreshBriefTop } from './briefTop';

export type ApplyOutcome =
	| {
			outcome: 'applied' | 'replayed';
			/** The stored extraction's status (a replay returns the stored one). */
			status: InterpretationStatus;
			interpretationId: Id<'messageInterpretations'>;
			interpretationRevision: number;
			createdItemIds: Id<'threadItems'>[];
			completeness: BriefCompleteness;
			/** When an incomplete extraction will be retried, if it will. */
			nextRetryAt?: number;
	  }
	| { outcome: 'stale'; interpretationRevision: number }
	| { outcome: 'erased' | 'gone' | 'modeChanged' | 'sourceChanged' };

/**
 * A source's two marked extractions: `current`, the one the replay folds in
 * (the newest that READ the message), and `counted`, the newest attempt,
 * which the source counters count. They differ while a later attempt failed:
 * its failure shows, the claims of the last good read stay.
 */
async function markedRowsOf(
	ctx: MutationCtx,
	sourceKey: string
): Promise<{
	current: Doc<'messageInterpretations'> | null;
	counted: Doc<'messageInterpretations'> | null;
}> {
	const current = await ctx.db
		.query('messageInterpretations')
		.withIndex('by_source_current', (q) => q.eq('sourceKey', sourceKey).eq('isCurrent', true))
		.first();
	const counted = await ctx.db
		.query('messageInterpretations')
		.withIndex('by_source_counted', (q) => q.eq('sourceKey', sourceKey).eq('isCounted', true))
		.first();
	return { current, counted: counted ?? current };
}

export const applyInterpretation = internalMutation({
	args: applyInterpretationArgs,
	handler: async (ctx, args): Promise<ApplyOutcome> => {
		const ref = args.threadRef;
		if (!(await sourceStillInThread(ctx, args.source, ref))) return { outcome: 'gone' };
		const mode = await resolveThreadMode(ctx, ref);
		if (!mode) return { outcome: 'gone' };
		const brief = await ensureBriefRow(ctx, ref, mode);
		if (!brief) return { outcome: 'gone' };
		if (brief.mode !== mode) {
			// The mailbox changed scope: the cached brief follows (no overview in actions mode).
			await ctx.db.patch(brief._id, { mode, overview: undefined, updatedAt: Date.now() });
		}
		if (mode !== args.mode) return { outcome: 'modeChanged' };
		if (brief.deletionEpoch !== args.deletionEpoch) return { outcome: 'erased' };
		if (
			args.sourceVersion !== undefined &&
			(await sourceVersionOf(ctx, args.source)) !== args.sourceVersion
		) {
			return { outcome: 'sourceChanged' };
		}

		const sourceKey = interpretationSourceKey(args.source);
		const now = Date.now();
		const existing = await ctx.db
			.query('messageInterpretations')
			.withIndex('by_source_revision', (q) =>
				q
					.eq('sourceKey', sourceKey)
					.eq('contentRevision', args.contentRevision)
					.eq('extractorVersion', args.extractorVersion)
			)
			.first();
		if (existing?.appliedAt !== undefined && !rowMatchesThreadRef(existing, ref)) {
			return { outcome: 'gone' };
		}
		const replayed = (row: Doc<'messageInterpretations'>): ApplyOutcome => ({
			outcome: 'replayed',
			status: row.status,
			interpretationId: row._id,
			interpretationRevision: brief.interpretationRevision,
			createdItemIds: [],
			completeness: brief.completeness,
			...(row.nextRetryAt !== undefined ? { nextRetryAt: row.nextRetryAt } : {}),
		});
		if (existing?.appliedAt !== undefined) {
			if (args.retryCount === undefined && existing.status === args.status)
				return replayed(existing);
			// A repair that read nothing never replaces what the earlier attempt read.
			if (!args.result && existing.payload !== undefined) {
				const retryRow = {
					...existing,
					retryCount: args.retryCount,
					errorCode: args.errorCode ?? existing.errorCode,
				};
				const nextRetryAt = nextRetryAtOf(retryRow, now);
				await ctx.db.patch(existing._id, {
					retryCount: args.retryCount,
					nextRetryAt,
					updatedAt: now,
				});
				return replayed({ ...existing, nextRetryAt });
			}
		}
		if (brief.interpretationRevision !== args.expectedRevision) {
			return { outcome: 'stale', interpretationRevision: brief.interpretationRevision };
		}

		const isOutOfOrder = !!brief.checkpoint && args.sourceAt < brief.checkpoint.sourceAt;
		const { current: previous, counted: previousCounted } = await markedRowsOf(ctx, sourceKey);
		// An attempt that read nothing never replaces the claims of the last good
		// read (review round 2 F2): it is recorded and counted, not folded in.
		const isKeepingPrevious = !args.result && previous?.payload !== undefined;
		const isReapply = previous?.appliedAt !== undefined && !isKeepingPrevious;
		let status: InterpretationStatus = args.status;
		let errorCode = args.errorCode;

		// Fold first, so a replay over budget can still mark this run partial.
		let isRebuild = isOutOfOrder || isReapply;
		let fold: Parameters<typeof writeState>[1] | null = null;
		const writeBase = {
			ref,
			mode,
			briefId: brief._id,
			keyBase: `interp:${sourceKey}:${args.contentRevision}:${args.extractorVersion}:${args.retryCount ?? 0}`,
			eventAt: args.sourceAt,
			...(ref.kind === 'mail' ? { mailboxId: (await ctx.db.get(ref.id))?.mailboxId } : {}),
			...(args.threadAssigneeUserId ? { assigneeUserId: args.threadAssigneeUserId } : {}),
			now,
		};
		const entry = args.result
			? {
					source: args.source,
					sourceKey,
					contentRevision: args.contentRevision,
					sourceAt: args.sourceAt,
					appliedAt: now,
					result: args.result,
				}
			: null;

		// Store the extraction (the replay reads it back as current).
		const record = {
			...threadRefToFields(ref),
			source: args.source,
			sourceKey,
			contentRevision: args.contentRevision,
			extractorVersion: args.extractorVersion,
			mode,
			status,
			...(args.skipReason ? { skipReason: args.skipReason } : {}),
			...(args.eligibility ? { eligibility: args.eligibility } : {}),
			...(args.sourceManifest ? { sourceManifest: args.sourceManifest } : {}),
			...(args.coverage ? { coverage: args.coverage } : {}),
			...(errorCode ? { errorCode } : {}),
			...exactWordingFieldsOf(args.result, previous),
			...(args.result
				? {
						payload: await sealBodyAtWrite(JSON.stringify(args.result)),
						payloadVersion: INTERPRET_PAYLOAD_VERSION,
					}
				: {}),
			...(args.sourceVersion ? { sourceVersion: args.sourceVersion } : {}),
			...(args.retryCount !== undefined ? { retryCount: args.retryCount } : {}),
			sourceAt: args.sourceAt,
			isCurrent: !isKeepingPrevious,
			isCounted: true,
			deletionEpoch: brief.deletionEpoch,
			appliedAt: now,
			updatedAt: now,
		};
		let interpretationId: Id<'messageInterpretations'>;
		if (existing) {
			await ctx.db.replace(existing._id, { ...record, createdAt: existing.createdAt });
			interpretationId = existing._id;
		} else {
			interpretationId = await ctx.db.insert('messageInterpretations', {
				...record,
				createdAt: now,
			});
		}
		if (previous && previous._id !== interpretationId && !isKeepingPrevious) {
			await ctx.db.patch(previous._id, { isCurrent: false, ...RETIRED_EXACT_WORDING });
		}
		if (previousCounted && previousCounted._id !== interpretationId) {
			await ctx.db.patch(previousCounted._id, { isCounted: false });
		}

		if (isRebuild && (entry || isReapply)) {
			const replay = await loadReplayState(ctx, ref, mode);
			if (replay.isOverBudget) {
				// Too long to replay within one transaction: fold incrementally (a late
				// message then moves no status) and say the brief is incomplete.
				isRebuild = false;
				status = 'partial';
				errorCode = 'replay_budget';
			} else {
				const after = replayThread(replay.entries, replay.base, replay.seed, {
					mode,
					threadKind: ref.kind,
				});
				applyHumanOps(after, replay.ops);
				fold = {
					...writeBase,
					after,
					rows: replay.rows,
					factRows: replay.factRows,
					isRebuild: true,
				};
			}
		}
		if (!fold && entry) {
			const inc = await loadIncrementalState(ctx, ref, mode, now);
			foldEntry(inc.state, entry, { mode, threadKind: ref.kind, isOutOfOrder });
			fold = {
				...writeBase,
				after: inc.state,
				rows: inc.rows,
				factRows: inc.factRows,
				isRebuild: false,
			};
		}

		const nextRetryAt = nextRetryAtOf({ status, errorCode, retryCount: args.retryCount }, now);
		if (status !== args.status || errorCode !== args.errorCode || nextRetryAt !== undefined) {
			await ctx.db.patch(interpretationId, {
				status,
				...(errorCode ? { errorCode } : {}),
				...(nextRetryAt !== undefined ? { nextRetryAt } : {}),
			});
		}
		const stored = { status, skipReason: args.skipReason };
		const sourceCounts = shiftCount(
			brief.sourceCounts ?? EMPTY_SOURCE_COUNTS,
			previousCounted ? sourceBucketOf(previousCounted) : null,
			sourceBucketOf(stored)
		);

		if (args.direction === 'inbound') {
			await appendActivity(ctx, {
				threadRef: ref,
				mode,
				eventAt: args.sourceAt,
				idempotencyKey: `received:${sourceKey}`,
				type: 'message_received',
				actor: { kind: 'sender' },
				provenance: 'recorded',
				payload: { source: sourceKey },
			});
		}
		const createdItemIds = fold ? await writeState(ctx, fold) : [];
		if (status === 'partial' || status === 'failed') {
			await appendActivity(ctx, {
				threadRef: ref,
				mode,
				eventAt: args.sourceAt,
				idempotencyKey: `${writeBase.keyBase}:incomplete:${status}`,
				type: 'interpretation_incomplete',
				actor: { kind: 'system' },
				provenance: 'recorded',
				payload: { status, ...(errorCode ? { code: errorCode } : {}) },
			});
		}

		const completeness = completenessOfCounts(sourceCounts);
		const fresh = (await ctx.db.get(brief._id)) ?? brief;
		const revision = brief.interpretationRevision + 1;
		await ctx.db.patch(brief._id, {
			interpretationRevision: revision,
			sourceRevision: fresh.sourceRevision + 1,
			sourceCounts,
			completeness,
			...(!isOutOfOrder
				? { checkpoint: { sourceKey, sourceAt: args.sourceAt, interpretationId } }
				: {}),
			updatedAt: now,
		});
		// The list rows, the Answer queue and the Workbench read this projection.
		if (ref.kind === 'mail') {
			await refreshBriefTop(ctx, ref.id, {
				latest: briefTopLatestOf(args.result, { mode, isOutOfOrder }),
			});
		}
		return {
			outcome: 'applied',
			status,
			interpretationId,
			interpretationRevision: revision,
			createdItemIds,
			completeness,
			...(nextRetryAt !== undefined ? { nextRetryAt } : {}),
		};
	},
});
