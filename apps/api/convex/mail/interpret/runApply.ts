/**
 * Writing an interpretation run's record through the reducer (split out of
 * `./run.ts` to hold it under the size cap): the apply that reloads the
 * revision while it is stale, and the run's source lease (`./lease.ts`).
 */

import type { Infer } from 'convex/values';
import type { ActionCtx } from '../../_generated/server';
import type { InterpretMode } from '@owlat/shared/threadBrief';
import type { ThreadRef } from '../../lib/validators/threadRef';
import type {
	InterpretationSource,
	interpretEligibilitySignalsValidator,
} from '../../lib/validators/threadBrief';
import { internal } from '../../_generated/api';
import { INTERPRET_EXTRACTOR_VERSION } from './schema';
import type { InterpretArgs, RunRecord } from './runShape';
import type { ApplyOutcome } from './reduce';
import type { Depth } from '@owlat/shared/arrival';
import type { LeaseClaim } from './lease';

/** Reducer attempts against a moving revision before the run gives up as partial. */
const MAX_APPLY_ATTEMPTS = 3;

/**
 * What `apply` reads of the run's loaded state. Spelled out (not inferred from
 * the load query) so this module's types never depend on the generated API.
 */
export interface ApplyState {
	readonly threadRef: ThreadRef;
	readonly mode: InterpretMode;
	readonly brief: { readonly interpretationRevision: number; readonly deletionEpoch: number };
	readonly sourceAt: number;
	readonly direction: 'inbound' | 'outbound';
	readonly eligibility?: Infer<typeof interpretEligibilitySignalsValidator> | null | undefined;
	readonly threadAssigneeUserId?: string | undefined;
}

/** Apply through the reducer, reloading the revision while it is stale. */
export async function apply(
	ctx: ActionCtx,
	args: InterpretArgs,
	loaded: ApplyState,
	record: RunRecord,
	/** The state again, for a write that found the revision stale. */
	reload: () => Promise<ApplyState | null>
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
			...(record.budgetDeferrals !== undefined ? { budgetDeferrals: record.budgetDeferrals } : {}),
			...(record.budgetRefusal ? { budgetRefusal: record.budgetRefusal } : {}),
			...(state.threadAssigneeUserId ? { threadAssigneeUserId: state.threadAssigneeUserId } : {}),
			...(args.leaseToken ? { leaseToken: args.leaseToken } : {}),
		});
		if (outcome.outcome !== 'stale') return outcome;
		const reloaded = await reload();
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

/** A run of a source without an enqueue snapshot: not interpreted, nothing recorded. */
type UnsnapshottedRun = {
	status: 'skipped';
	isReplayed: false;
	createdItemIds: never[];
	errorCode: 'no_snapshot';
};
const unsnapshotted = (): UnsnapshottedRun => ({
	status: 'skipped',
	isReplayed: false,
	createdItemIds: [],
	errorCode: 'no_snapshot',
});

/**
 * Run `body` under the source's lease: claimed first, released however
 * `body` ends (a no-op when its commit already cleared it). `busy` and `done`
 * come back without running `body`, and so does a source with no snapshot
 * row: never run unleased (Sol fixes-r3 F1).
 */
export async function withSourceLease<R>(
	ctx: Pick<ActionCtx, 'runMutation'>,
	source: InterpretationSource,
	depth: Depth | undefined,
	body: (token: string) => Promise<R>
): Promise<R | { status: 'busy'; retryAt: number } | { status: 'done' } | UnsnapshottedRun> {
	const claim: LeaseClaim = await ctx.runMutation(internal.mail.interpret.lease.claimSourceLease, {
		source,
		...(depth ? { depth } : {}),
	});
	if (claim.kind === 'busy') return { status: 'busy', retryAt: claim.retryAt };
	if (claim.kind === 'done') return { status: 'done' };
	if (claim.kind === 'unsnapshotted') return unsnapshotted();
	try {
		return await body(claim.token);
	} finally {
		await ctx
			.runMutation(internal.mail.interpret.lease.releaseSourceLease, { source, token: claim.token })
			.catch(() => undefined); // it expires on its own
	}
}
