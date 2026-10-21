/**
 * Read on arrival (INBOX_ZERO_PLAN, SPEC §2.9): the shared vocabulary of the
 * arrival record, the thread projection, sender profiles and the undo log.
 *
 * Types and closed lists only. The functions that decide (`chooseArrivalDepth`
 * in `arrivalDepth.ts`, `computePlacement` in `arrivalPlacement.ts`) are lane
 * arrival's; this module fixes their input and output shapes so every lane
 * builds against the same contract. The Convex validators are built from the
 * lists below (`apps/api/convex/lib/validators/arrival.ts`), so the two can
 * never drift.
 *
 * Imports nothing: safe for the web app, the API and every Docker image that
 * copies this package's source.
 */

/** Where a thread reads in the Priority view (§2.8, §3). */
export const PLACEMENTS = ['needs_me', 'today', 'updates', 'digest', 'archived'] as const;
export type Placement = (typeof PLACEMENTS)[number];

/** How far the arrival read went (§2.2). */
export const DEPTHS = ['full', 'gist', 'count', 'none'] as const;
export type Depth = (typeof DEPTHS)[number];

/**
 * `chooseArrivalDepth`'s answer: a depth, or `deferred` (row 3, the
 * preference is off): not a depth, the caller keeps today's D10 deferral.
 */
export type ArrivalDepthDecision = Depth | 'deferred';

/** A machine reason with params; the UI renders it from i18n (never composed text). */
export interface ReasonKey {
	key: string;
	params?: Record<string, string | number>;
}

/**
 * The reason keys the contract itself names (§2.3, §2.6); lanes add their own
 * and export the runtime constants where they first write them.
 * @public Contract type for the read-on-arrival lanes.
 */
export type ArrivalReasonKey =
	| 'arrival.reason.budget'
	| 'arrival.reason.ownerLimit'
	| 'arrival.reason.categoryTimeout';

/** Smart-inbox categories; mirrors `mailCategoryLabelValidator` (type-parity-tested in the API). */
export type MailCategory =
	| 'person'
	| 'newsletter'
	| 'notification'
	| 'receipt'
	| 'promotion'
	| 'spam'
	| 'other';

/** Who assigned a category; `user` overrides the classifiers. */
export type CategorySource = 'heuristic' | 'llm' | 'user';

/** A sender's standing (§5). Absent profile = `keep` with `statusSource: 'default'`. */
export const SENDER_STATUSES = ['keep', 'digest', 'auto_archive', 'unsubscribed'] as const;
export type SenderStatus = (typeof SENDER_STATUSES)[number];

/** Who set a sender's status. `user` and `suggestion` are never changed by learning (§4.3). */
export const SENDER_STATUS_SOURCES = ['default', 'user', 'suggestion', 'learned'] as const;
export type SenderStatusSource = (typeof SENDER_STATUS_SOURCES)[number];

/** The placements a sender-scope override may pin (§4.2). */
export const SENDER_PLACEMENT_OVERRIDES = ['needs_me', 'today', 'updates'] as const;
export type SenderPlacementOverride = (typeof SENDER_PLACEMENT_OVERRIDES)[number];

/** A thread-scope (message-scope Fix) placement override. */
export interface PlacementOverride {
	placement: Placement;
	setAt: number;
	/** `mailArrivalOperations` id (a string here, `Id<'mailArrivalOperations'>` in the API). */
	operationId: string;
}

/** The budget mapping of §2.6: any refusal is `refused`. */
export type ArrivalBudget = 'normal' | 'refused';

/** `chooseArrivalDepth`'s input (§2.2). */
export interface ChooseArrivalDepthInput {
	isReadOnArrival: boolean;
	isAiOn: boolean;
	isEligible: boolean;
	isDisplayOnly: boolean;
	senderStatus: SenderStatus | undefined;
	/** The thread override (message scope), else the sender override (§4.2). */
	placementOverride?: Placement;
	/** A matching `sendToDigest` rule. */
	ruleDepthHint?: 'count';
	category: MailCategory;
	categorySource: CategorySource;
	/** The existing security-mail suppression signals (eligibility/ground). */
	isSecurityMail: boolean;
	/** The §2.4 pre-gist detector (`exactWordingDetector.ts`). */
	isExactWordingCandidate: boolean;
	budget: ArrivalBudget;
}

/** `chooseArrivalDepth`'s output. */
export interface ChooseArrivalDepthResult {
	depth: ArrivalDepthDecision;
	reasonKeys: ReasonKey[];
}

/** @public Contract type for the read-on-arrival lanes. */
export type ChooseArrivalDepth = (input: ChooseArrivalDepthInput) => ChooseArrivalDepthResult;

/** The arrival-record half of `computePlacement`'s input (§2.8). */
export interface PlacementRecordInput {
	/** From a matched placement/digest rule action. */
	rulePlacement?: Placement;
	category?: MailCategory;
	categorySource?: CategorySource;
	/**
	 * The §2.4 exact-wording detector flagged this message's own text: it is
	 * never placed in the digest or updates (#1384).
	 */
	isExactWordingCandidate?: boolean;
}

/** The thread half: its override and whether a needs-reply verdict is SETTLED. */
export interface PlacementThreadInput {
	placementOverride?: Pick<PlacementOverride, 'placement'>;
	/** `mailThreads.needsReply` is set. A heuristic candidate still pending is false. */
	isReplyNeeded: boolean;
}

/** The sender half; null when the sender has no profile (reads as `keep`). */
export interface PlacementSenderInput {
	status: SenderStatus;
	placementOverride?: SenderPlacementOverride;
}

/** Which precedence step of §2.8 decided the placement (the Explain popover shows it). */
export type PlacementDecider =
	| 'thread_override'
	| 'needs_reply'
	| 'sender_status'
	| 'sender_override'
	| 'rule'
	| 'category'
	/** An exact-wording candidate lifted out of the digest or updates (#1384). */
	| 'exact_wording';

export interface ComputePlacementResult {
	placement: Placement;
	decidedBy: PlacementDecider;
}

/** @public Contract type for the read-on-arrival lanes. */
export type ComputePlacement = (
	record: PlacementRecordInput,
	thread: PlacementThreadInput,
	senderProfile: PlacementSenderInput | null
) => ComputePlacementResult;

/** Why a record read less than its row would allow (§2.6, §2.1). */
export const DEGRADED_BY = ['budget', 'owner_limit', 'ai_off', 'read_on_arrival_off'] as const;
/** @public Contract type for the read-on-arrival lanes. */
export type DegradedBy = (typeof DEGRADED_BY)[number];

/** Writers of an exclusive action (folder, section, placement), §6.2 rule 5. */
export const EXCLUSIVE_WINNER_SOURCES = ['manual', 'hook', 'ai', 'sender_status'] as const;
export type ExclusiveWinnerSource = (typeof EXCLUSIVE_WINNER_SOURCES)[number];

export interface ExclusiveWinner {
	source: ExclusiveWinnerSource;
	/** `mailFilters` id; absent for `sender_status`. */
	filterId?: string;
	/**
	 * The filter's priority (lower runs first). A later writer wins only with a
	 * LOWER number; ties go to the earlier writer. Sender-status enforcement ranks
	 * after every filter: it records `Number.MAX_SAFE_INTEGER` (not `Infinity`, so
	 * the value survives every JSON boundary).
	 */
	priority: number;
	/** Folder winners: the folder the winning move put the message in. */
	folderId?: string;
}

/** @public Contract type for the read-on-arrival lanes. */
export interface ExclusiveWinners {
	folder?: ExclusiveWinner;
	section?: ExclusiveWinner;
	placement?: ExclusiveWinner;
}

/** The undo log (§4.4). */
export const ARRIVAL_OPERATION_KINDS = [
	'fix',
	'sender_status',
	'learned_status',
	'sender_archive',
	'unsubscribe',
	'draft_resume',
	// The unused-draft streak paused draft-on-arrival for a sender, or an AI-based send reset it (§7).
	'draft_pause',
	'suggestions',
	'rule_apply',
	'delayed_archive',
] as const;
/** @public Contract type for the read-on-arrival lanes. */
export type ArrivalOperationKind = (typeof ARRIVAL_OPERATION_KINDS)[number];

export const ARRIVAL_OPERATION_ACTORS = ['user', 'learning', 'rule', 'system'] as const;
/** @public Contract type for the read-on-arrival lanes. */
export type ArrivalOperationActor = (typeof ARRIVAL_OPERATION_ACTORS)[number];

export const ARRIVAL_OPERATION_STATUSES = ['applied', 'undone', 'undo_partial'] as const;
/** @public Contract type for the read-on-arrival lanes. */
export type ArrivalOperationStatus = (typeof ARRIVAL_OPERATION_STATUSES)[number];

export interface SenderStatusValue {
	status: SenderStatus;
	statusSource: SenderStatusSource;
}

export interface SenderDraftPauseValue {
	autoDraftPausedAt?: number;
	unusedDraftStreak: number;
}

/**
 * One changed entity of an operation (`mailArrivalOperationChanges.change`).
 * Ids are strings here; the API's validator types them. Undo restores a row
 * only when the entity still equals `after` (SPEC §4.4). The message-level
 * kinds (`messageFolder`, `messageRead`, `messageLabel`, `messageFlag`,
 * `messageSection`) check that value only: messages carry no operation marker.
 * Every other kind also requires its entity's last-operation id to still name
 * this operation (`mailArrivalRecords.lastOperationId` for
 * `recordRulePlacement`, `mailThreads.lastArrivalOperationId`,
 * `mailSenderProfiles.lastOperationId`).
 */
export type ArrivalOperationChange =
	| { kind: 'messageFolder'; messageId: string; before: string; after: string }
	| { kind: 'messageRead'; messageId: string; before: boolean; after: boolean }
	| {
			kind: 'threadPlacementOverride';
			threadId: string;
			before: PlacementOverride | null;
			after: PlacementOverride | null;
	  }
	| {
			kind: 'senderStatus';
			senderDigest: string;
			before: SenderStatusValue;
			after: SenderStatusValue;
	  }
	| {
			kind: 'senderPlacementOverride';
			senderDigest: string;
			before: SenderPlacementOverride | null;
			after: SenderPlacementOverride | null;
	  }
	| {
			kind: 'senderDraftPause';
			senderDigest: string;
			before: SenderDraftPauseValue;
			after: SenderDraftPauseValue;
	  }
	| { kind: 'messageLabel'; messageId: string; labelId: string; before: boolean; after: boolean }
	| { kind: 'messageFlag'; messageId: string; before: boolean; after: boolean }
	| { kind: 'messageSection'; messageId: string; before: string | null; after: string | null }
	| {
			kind: 'recordRulePlacement';
			messageId: string;
			before: Placement | null;
			after: Placement | null;
	  };

/** @public Contract type for the read-on-arrival lanes. */
export type ArrivalOperationChangeKind = ArrivalOperationChange['kind'];

/** Digest groups (§6.5). */
export const DIGEST_KINDS = ['newsletter', 'updates', 'promotion'] as const;
/** @public Contract type for the read-on-arrival lanes. */
export type DigestKind = (typeof DIGEST_KINDS)[number];

/** The filter action types this plan adds (§6.3). */
export const ARRIVAL_FILTER_ACTION_TYPES = [
	'sendToDigest',
	'placeInUpdates',
	'placeInNeedsMe',
	'archiveAfter',
	'notify',
] as const;
export type ArrivalFilterActionType = (typeof ARRIVAL_FILTER_ACTION_TYPES)[number];

/** Where a filter came from (§6.1). Absent on a stored row = `manual`. */
export const FILTER_ORIGINS = ['manual', 'plain_language', 'fix'] as const;
/** @public Contract type for the read-on-arrival lanes. */
export type FilterOrigin = (typeof FILTER_ORIGINS)[number];
