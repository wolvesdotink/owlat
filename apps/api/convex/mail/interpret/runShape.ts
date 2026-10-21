/**
 * The shapes of an interpretation run (`run.ts`, split out at the file-size
 * cap): its arguments, its answer, the record it hands the reducer, and the
 * pure mapping from the reducer's outcome to the run's answer.
 */

import type { Infer } from 'convex/values';
import type { Id } from '../../_generated/dataModel';
import type { InterpretationStatus, InterpretMode } from '@owlat/shared/threadBrief';
import type { BudgetHoldReason } from '@owlat/shared/aiRouting';
import type {
	InterpretationSource,
	interpretCoverageValidator,
	sourceManifestValidator,
} from '../../lib/validators/threadBrief';
import type { LlmRootContext } from '../../lib/llm/requestMeter';
import type { NeedsReplyProjection } from './needsReplyProjection';
import type { ReduceResult } from './reduceInput';
import type { ApplyOutcome } from './reduce';
import type { PredecessorMode } from './defer';
import type { Depth } from '@owlat/shared/arrival';

export interface InterpretArgs {
	source: InterpretationSource;
	/** Ignored: the mode is the thread's current one, rechecked by the reducer. */
	mode?: InterpretMode;
	/** Ignored: eligibility comes from the snapshot taken at enqueue (`sources.ts`). */
	isLive?: boolean;
	precedence?: string;
	listId?: string;
	/** D10: how the thread's earlier deferred mail is handled (`defer.ts`). */
	predecessors?: PredecessorMode;
	/** The awaiting caller's root, deadline included; else the message's own. */
	root?: LlmRootContext;
	/** The depth asked for; a source already terminal for it is `done` (`lease.ts`). */
	depth?: Depth;
	/**
	 * A full-read prerequisite's upgrade (`fullRead.ts`): it reads the thread's
	 * earlier gist-only and counted mail first. An open (also `full`) does not.
	 */
	isUpgrade?: boolean;
	/** Set by the predecessor loop: the run whose loop reads this source (`arrivalAdmit.ts`). */
	parentSource?: InterpretationSource;
	/** Set by the run itself: the source lease it holds, checked at commit (`lease.ts`). */
	leaseToken?: string;
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
			/** `errorCode: 'budget'` from a refusal this run met: its reason and limit (Sol r3 F5). */
			budgetRefusal?: RunBudgetRefusal;
	  }
	/** The source or its thread is gone, or a purge ran meanwhile: nothing written. */
	| { status: 'gone' }
	/** Another run holds the source's lease (`lease.ts`): nothing done; try at `retryAt`. */
	| { status: 'busy'; retryAt: number }
	/** The run waits for the thread's category (`categoryDefer.ts`) until at most `retryAt`. */
	| { status: 'wait'; retryAt: number }
	/** The source is already terminal for the depth asked for. */
	| { status: 'done' };

/** A spend admission refusal the run met, for a caller that holds on it. */
export type RunBudgetRefusal = { reason: BudgetHoldReason; limit: string };

export type RunRecord = {
	contentRevision: string;
	status: InterpretationStatus;
	skipReason?: 'short' | 'bulk' | 'security' | 'undecryptable' | 'ineligible';
	errorCode?: string;
	sourceManifest?: Infer<typeof sourceManifestValidator>;
	coverage?: Infer<typeof interpretCoverageValidator>;
	result?: ReduceResult;
	sourceVersion?: string;
	retryCount?: number;
	/** The run's hold was refused: consecutive deferrals, which back the retry off (Sol r4). */
	budgetDeferrals?: number;
	/** A spend refusal the run met, stored so a replay reports it (Sol r2 F1). */
	budgetRefusal?: RunBudgetRefusal;
};

/**
 * The run must start over: the body or the thread's mode changed under it, or
 * the category it was about to wait for settled meanwhile.
 */
export type Restart = { restart: 'modeChanged' | 'sourceChanged' | 'categorySettled' };

/** The failure a run records when it had to start over on every attempt. */
export const RESTART_ERROR_CODE: Record<Restart['restart'], string> = {
	sourceChanged: 'source_changed',
	modeChanged: 'mode_changed',
	categorySettled: 'category_changed',
};

/** The run's answer from the reducer's; `restart` when the run must start over. */
export function finish(
	outcome: ApplyOutcome,
	extra: {
		projection?: NeedsReplyProjection;
		errorCode?: string;
		budgetRefusal?: RunBudgetRefusal;
	} = {}
): InterpretRunResult | Restart {
	switch (outcome.outcome) {
		case 'gone':
		case 'erased':
			return { status: 'gone' };
		case 'leaseLost':
			// Another run took the source over: its commit is the one that counts.
			return { status: 'busy', retryAt: outcome.retryAt };
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
