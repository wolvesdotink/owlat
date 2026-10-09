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
 *      extractor version; the last read of a source is `isCurrent`, its newest
 *      attempt `isCounted`; an attempt that read nothing is its own row) and
 *      move the source counters;
 *   4. fold it in, MONOTONE (`fold.ts`): a new message, a late one and a
 *      re-read all merge on top of the thread's items through the same
 *      planner and its guards; transitions are order-aware; a re-read never
 *      retires what it no longer shows, it flags it for review. Rows the
 *      model or the source's claim record names are loaded by id, and
 *      transitions waiting for their item are applied when it appears
 *      (`reduceIdentity.ts`);
 *   5. write the difference with activity and item counters (`reduceWrite.ts`);
 *   6. bump the brief row (revision, checkpoint, completeness from the
 *      counters) and refresh the list-row projection.
 */

import type { Doc, Id } from '../../_generated/dataModel';
import type { MutationCtx } from '../../_generated/server';
import { internal } from '../../_generated/api';
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
import { briefTopLatestOf, loadFoldState, sourceStillInThread } from './reduceState';
import { flagUnreproduced, foldEntry } from './fold';
import {
	identityTargets,
	loadIdentityTargets,
	pendingFieldsOf,
	sourceClaimIds,
	storeClaimIds,
} from './reduceIdentity';
import { writeState } from './reduceWrite';
import { EMPTY_SOURCE_COUNTS, shiftCount, sourceBucketOf } from './counters';
import {
	abandonRepair,
	briefCompleteness,
	isRepairMarked,
	shiftPendingRepairs,
} from './purgeRepairs';
import { settleSource } from './outstanding';
import { nextRetryAtOf } from './retry';
import { ATTEMPT_SUFFIX } from './load';
import { sourceVersionOf } from './sourceVersion';
import { refreshBriefTop } from './briefTop';
import { onItemsCreated } from './commitmentLink';
import { startPendingMatch } from './pendingMatch';

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
			/**
			 * The thread holds more items or current facts than the fold scanned
			 * (named rows were still loaded by id): the brief stays partial (R2).
			 */
			isItemScanCut?: true;
			/** The source's claim record reached its limit (its recorded keys still resolve). */
			isClaimRecordFull?: true;
	  }
	| { outcome: 'stale'; interpretationRevision: number }
	| { outcome: 'erased' | 'gone' | 'modeChanged' | 'sourceChanged' };

/**
 * A source's two marked extractions: `current`, its last good read
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
		if (brief.deletionEpoch !== args.deletionEpoch) {
			// A purge repair refused here cannot leave its counter behind (purgeRepairs.ts).
			const { counted } = await markedRowsOf(ctx, interpretationSourceKey(args.source));
			await abandonRepair(ctx, brief._id, counted);
			return { outcome: 'erased' };
		}
		if (
			args.sourceVersion !== undefined &&
			(await sourceVersionOf(ctx, args.source)) !== args.sourceVersion
		) {
			return { outcome: 'sourceChanged' };
		}

		const sourceKey = interpretationSourceKey(args.source);
		const now = Date.now();
		const { current: previous, counted: previousCounted } = await markedRowsOf(ctx, sourceKey);
		// An attempt that read nothing never replaces the claims of the last good
		// read: it is recorded beside it (its own row, `<revision>~attempt`) and
		// counted, and the good read stays current (round 2 F2, round 3 P3).
		const isKeepingPrevious = !args.result && previous?.payload !== undefined;
		const rowRevision = isKeepingPrevious
			? `${args.contentRevision}${ATTEMPT_SUFFIX}`
			: args.contentRevision;
		const existing = await ctx.db
			.query('messageInterpretations')
			.withIndex('by_source_revision', (q) =>
				q
					.eq('sourceKey', sourceKey)
					.eq('contentRevision', rowRevision)
					.eq('extractorVersion', args.extractorVersion)
			)
			.first();
		if (existing?.appliedAt !== undefined && !rowMatchesThreadRef(existing, ref)) {
			return { outcome: 'gone' };
		}
		// A replay only on an exact match: the same row is the counted one (and the
		// current one when it read the message), same mode, same outcome, no retry.
		if (
			existing?.appliedAt !== undefined &&
			(existing.retryCount ?? 0) === (args.retryCount ?? 0) &&
			existing.status === args.status &&
			existing.mode === mode &&
			existing.isCounted !== false &&
			(!args.result || existing.isCurrent === true)
		) {
			// A replayed outcome is an outcome: the source is no longer outstanding.
			await settleSource(ctx, sourceKey, 'recorded');
			return {
				outcome: 'replayed',
				status: existing.status,
				interpretationId: existing._id,
				interpretationRevision: brief.interpretationRevision,
				createdItemIds: [],
				completeness: brief.completeness,
				...(existing.nextRetryAt !== undefined ? { nextRetryAt: existing.nextRetryAt } : {}),
			};
		}
		if (brief.interpretationRevision !== args.expectedRevision) {
			return { outcome: 'stale', interpretationRevision: brief.interpretationRevision };
		}

		const isOutOfOrder = !!brief.checkpoint && args.sourceAt < brief.checkpoint.sourceAt;
		const isReapply = previous?.appliedAt !== undefined && !isKeepingPrevious;
		const status: InterpretationStatus = args.status;
		const errorCode = args.errorCode;
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

		// Store the extraction.
		const record = {
			...threadRefToFields(ref),
			source: args.source,
			sourceKey,
			contentRevision: rowRevision,
			extractorVersion: args.extractorVersion,
			mode,
			status,
			...(args.skipReason ? { skipReason: args.skipReason } : {}),
			...(args.eligibility ? { eligibility: args.eligibility } : {}),
			...(args.sourceManifest ? { sourceManifest: args.sourceManifest } : {}),
			...(args.coverage ? { coverage: args.coverage } : {}),
			...(errorCode ? { errorCode } : {}),
			// Only a read carries the flag; a failed attempt never does (round 4 M4).
			...(args.result ? exactWordingFieldsOf(args.result, previous) : {}),
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
			// A replaced read's waiting transitions go with it.
			await ctx.db.patch(previous._id, {
				isCurrent: false,
				...RETIRED_EXACT_WORDING,
				...pendingFieldsOf([]),
			});
		}
		if (previousCounted && previousCounted._id !== interpretationId) {
			await ctx.db.patch(previousCounted._id, { isCounted: false });
		}

		// Monotone (round 4 M1/M2): every extraction folds on top of what the
		// thread holds; a re-read merges by identity and flags what it no
		// longer shows, it never retires anything.
		let claims: Awaited<ReturnType<typeof sourceClaimIds>> | null = null;
		let isItemScanCut = false;
		if (entry) {
			const loaded = await loadFoldState(ctx, ref, mode);
			isItemScanCut = loaded.isItemScanCut || loaded.isFactScanCut;
			// Identity beyond the scan (round 5 F5): named rows, loaded by id.
			claims = await sourceClaimIds(ctx, sourceKey);
			await loadIdentityTargets(
				ctx,
				ref,
				mode,
				loaded,
				identityTargets(entry.result, sourceKey, claims.claimIds, { isReapply })
			);
			const foldOpts = { mode, threadKind: ref.kind, isOutOfOrder };
			const { plan, touched } = foldEntry(loaded.state, entry, foldOpts, claims.claimIds);
			if (isReapply) flagUnreproduced(loaded.state, sourceKey, touched);
			// Completions read before their request (round 5 F7): kept, and
			// proposed to the items a later fold creates (pendingMatch.ts).
			await ctx.db.patch(interpretationId, pendingFieldsOf(plan.unresolved));
			fold = { ...writeBase, after: loaded.state, rows: loaded.rows, factRows: loaded.factRows };
		}

		const nextRetryAt = nextRetryAtOf({ status, errorCode, retryCount: args.retryCount }, now);
		if (nextRetryAt !== undefined) await ctx.db.patch(interpretationId, { nextRetryAt });
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
		const written = fold ? await writeState(ctx, fold) : null;
		const createdItemIds = written?.created ?? [];
		// Commitments extracted before this message was interpreted link now.
		await onItemsCreated(ctx, args.source, createdItemIds);
		const isClaimRecordFull =
			written && fold && claims
				? await storeClaimIds(ctx, claims.sourceRow, fold.after, sourceKey, written.ids)
				: false;
		const matchRun = await startPendingMatch(ctx, ref, brief, createdItemIds, sourceKey);
		if (matchRun) {
			await ctx.scheduler.runAfter(
				0,
				internal.mail.interpret.pendingMatch.matchPendingTransitions,
				matchRun
			);
		}
		const isMatching = matchRun !== null;
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

		// This run recorded a purge repair's result: the repair is no longer outstanding.
		if (previousCounted && isRepairMarked(previousCounted)) {
			await shiftPendingRepairs(ctx, brief._id, -1);
		}
		// This source has its outcome now: no longer outstanding (p4 final review F2).
		await settleSource(ctx, sourceKey, 'recorded');
		// A pending-transition scan in flight keeps the brief partial (round 6 R2),
		// and so do an outstanding purge repair and unread history (briefCompleteness).
		const briefNow = await ctx.db.get(brief._id);
		// So does a fold that read only part of the thread (round 6 W-F8).
		const isScanCut = entry ? isItemScanCut : briefNow?.isFoldScanCut === true;
		const completeness = isMatching
			? 'partial'
			: briefCompleteness({ ...(briefNow ?? brief), sourceCounts, isFoldScanCut: isScanCut });
		const fresh = (await ctx.db.get(brief._id)) ?? brief;
		const revision = brief.interpretationRevision + 1;
		await ctx.db.patch(brief._id, {
			interpretationRevision: revision,
			sourceRevision: fresh.sourceRevision + 1,
			sourceCounts,
			completeness,
			...(entry ? { isFoldScanCut: isItemScanCut ? true : undefined } : {}),
			// The checkpoint (and so "Latest update") only ever points at a current
			// extraction that read the message, never at a failed attempt (M4).
			...(!isOutOfOrder && !isKeepingPrevious && args.result
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
			...(isItemScanCut ? { isItemScanCut: true as const } : {}),
			...(isClaimRecordFull ? { isClaimRecordFull: true as const } : {}),
		};
	},
});
