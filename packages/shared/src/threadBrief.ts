/**
 * Thread brief: the shared vocabulary and pure rules of per-thread items,
 * facts and activity (SPEC §0, §3).
 *
 * One list per vocabulary. The Convex validators (`apps/api/convex/lib/
 * validators/threadBrief.ts`), the interpretation call's zod contract
 * (`mail/interpret/schema.ts`) and the web brief components all derive from
 * these tuples, so a new value is added here and every consumer follows.
 *
 * Words used here:
 * - an ITEM is one obligation (a question, request, decision or promise);
 * - a FACT is an informational claim, personal mail only;
 * - ACTIVITY is the append-only per-thread log.
 *
 * The pure rules over this vocabulary (item state, reactions, ordering,
 * lifecycle edges) live in `threadBriefRules.ts`
 * (`@owlat/shared/threadBriefRules`).
 *
 * Pure and import-free: safe in the Convex V8 runtime, in Node actions and in
 * the browser.
 */

// ── Thread references ──────────────────────────────────────────────────────

/** `mail` = a Postbox `mailThreads` row, `team` = an agent inbox `conversationThreads` row. */
export const THREAD_REF_KINDS = ['mail', 'team'] as const;
/** @public Contract type for the thread brief lanes. */
export type ThreadRefKind = (typeof THREAD_REF_KINDS)[number];

/** `brief` for personal Postbox mailboxes, `actions` for every team surface (no latest, no facts). */
export const INTERPRET_MODES = ['brief', 'actions'] as const;
export type InterpretMode = (typeof INTERPRET_MODES)[number];

/** The two reader views of a personal thread. */
export const THREAD_VIEWS = ['overview', 'conversation'] as const;
/** @public Contract type for the thread brief lanes. */
export type ThreadView = (typeof THREAD_VIEWS)[number];

// ── Items ──────────────────────────────────────────────────────────────────

export const ITEM_INTENTS = ['question', 'request', 'decision', 'promise'] as const;
export type ItemIntent = (typeof ITEM_INTENTS)[number];

export const ITEM_FACETS = [
	'payment',
	'meeting',
	'documentReview',
	'signature',
	'file',
	'access',
	'information',
] as const;
export type ItemFacet = (typeof ITEM_FACETS)[number];

/** Projection of the `responsible` party. The teammate assignee is a separate field. */
export const ITEM_RESPONSIBILITIES = ['us', 'them', 'unclear'] as const;
export type ItemResponsibility = (typeof ITEM_RESPONSIBILITIES)[number];

/** The work. Edges: `LEGAL_STATUS_EDGES` (threadBriefRules.ts). */
export const ITEM_STATUSES = ['open', 'done', 'declined', 'superseded', 'untracked'] as const;
export type ItemStatus = (typeof ITEM_STATUSES)[number];

/** What we told the other side. Independent of status. Edges: `isLegalDispositionEdge` (threadBriefRules.ts). */
export const ITEM_DISPOSITIONS = [
	'unanswered',
	'answered',
	'accepted',
	'deferred',
	'declined',
	'failed',
] as const;
export type ItemDisposition = (typeof ITEM_DISPOSITIONS)[number];

/**
 * How a `done` item came to be done: `recorded` = Owlat saw the op happen,
 * `asserted` = a person said so (Mark done), `reported` = an email said so.
 */
export const ITEM_COMPLETIONS = ['recorded', 'asserted', 'reported'] as const;
export type ItemCompletion = (typeof ITEM_COMPLETIONS)[number];

/** Verifier outcome: `proposal` items show as "Check this" and are not tracked until confirmed. */
export const ITEM_VERIFY_STATES = ['passed', 'proposal', 'na'] as const;
/** @public Contract type for the thread brief lanes. */
export type ItemVerifyState = (typeof ITEM_VERIFY_STATES)[number];

/** What a human correction on an item said. A correction is never flipped by a model proposal. */
export const ITEM_CORRECTION_KINDS = [
	'markedDone',
	'reopened',
	'untracked',
	'notARequest',
	'confirmed',
] as const;
/** @public Contract type for the thread brief lanes. */
export type ItemCorrectionKind = (typeof ITEM_CORRECTION_KINDS)[number];

// ── Response plans ─────────────────────────────────────────────────────────

export const RESPONSE_STANCES = [
	'answer',
	'accept',
	'decline',
	'defer',
	'clarify',
	'skip',
] as const;
/** @public Contract type for the thread brief lanes. */
export type ResponseStance = (typeof RESPONSE_STANCES)[number];

/** Per-item coverage of a draft. Shown as "Addressed in draft", never "Done". */
export const COVERAGE_VERDICTS = ['addressed', 'partial', 'notAddressed', 'skipped'] as const;
/** @public Contract type for the thread brief lanes. */
export type CoverageVerdict = (typeof COVERAGE_VERDICTS)[number];

/** Whole-plan verdict of a draft's self-check. `stale` = bound to an older draft hash or revision. */
export const PLAN_VERDICTS = ['pending', 'covered', 'gaps', 'stale'] as const;
/** @public Contract type for the thread brief lanes. */
export type PlanVerdict = (typeof PLAN_VERDICTS)[number];

export const DRAFT_REF_KINDS = ['mailDraft', 'inboundDraft'] as const;
/** @public Contract type for the thread brief lanes. */
export type DraftRefKind = (typeof DRAFT_REF_KINDS)[number];

// ── Facts ──────────────────────────────────────────────────────────────────

export const FACT_STATUSES = ['current', 'superseded', 'retracted'] as const;
/** @public Contract type for the thread brief lanes. */
export type FactStatus = (typeof FACT_STATUSES)[number];

export const FACT_VALUE_KINDS = ['date', 'money', 'ref', 'url', 'text'] as const;
/** @public Contract type for the thread brief lanes. */
export type FactValueKind = (typeof FACT_VALUE_KINDS)[number];

/** A fact's identity inside one thread. */
export interface FactKey {
	entity: string;
	attribute: string;
	context?: string | null;
}

/**
 * The stored, indexable form of a {@link FactKey}: each part trimmed, lowercased
 * and whitespace-collapsed, joined with `|`. Two proposals naming the same
 * entity/attribute/context get the same string.
 */
export function factKeyString(key: FactKey): string {
	const part = (value: string | null | undefined) =>
		(value ?? '').normalize('NFKC').trim().toLowerCase().replace(/\s+/g, ' ').replace(/\|/g, '/');
	return `${part(key.entity)}|${part(key.attribute)}|${part(key.context)}`;
}

// ── Activity ───────────────────────────────────────────────────────────────

export const ACTIVITY_TYPES = [
	// Messages and sends
	'message_received',
	'reply_sent',
	'auto_sent',
	'send_queued',
	'send_held',
	'send_cancelled',
	'delivery_failed',
	// Files and bookings
	'file_added_to_draft',
	'booked',
	// Items
	'item_opened',
	'item_changed',
	'item_closed',
	'item_reopened',
	'item_replaced',
	'item_assigned',
	'item_claimed',
	'item_reminder_set',
	'item_corrected',
	'proposal_confirmed',
	'clarification_answered',
	// Facts and interpretation
	'fact_changed',
	'interpretation_incomplete',
	// Thread housekeeping
	'assigned',
	'snoozed',
	'labelled',
	'archived',
	'muted',
] as const;
export type ActivityType = (typeof ACTIVITY_TYPES)[number];

export const ACTIVITY_ACTORS = ['user', 'agent', 'sender', 'system'] as const;
export type ActivityActor = (typeof ACTIVITY_ACTORS)[number];

/** How Owlat knows: saw it (`recorded`), a person said so (`asserted`), an email said so (`reported`). */
export const ACTIVITY_PROVENANCES = ['recorded', 'asserted', 'reported'] as const;
/** @public Contract type for the thread brief lanes. */
export type ActivityProvenance = (typeof ACTIVITY_PROVENANCES)[number];

/** `substance` shows by default; `housekeeping` (assign, snooze, label, …) is one toggle away. */
export const ACTIVITY_VISIBILITIES = ['substance', 'housekeeping'] as const;
export type ActivityVisibility = (typeof ACTIVITY_VISIBILITIES)[number];

/** What an activity row links to. */
export const ACTIVITY_OP_REF_KINDS = [
	'outbound',
	'booking',
	'audit',
	'agentAction',
	'note',
] as const;
/** @public Contract type for the thread brief lanes. */
export type ActivityOpRefKind = (typeof ACTIVITY_OP_REF_KINDS)[number];

const HOUSEKEEPING_ACTIVITY: ReadonlySet<ActivityType> = new Set<ActivityType>([
	'assigned',
	'snoozed',
	'labelled',
	'archived',
	'muted',
	'item_assigned',
	'item_claimed',
	'item_reminder_set',
]);

/** The visibility an activity type gets unless its writer has a reason to differ. */
export function defaultActivityVisibility(type: ActivityType): ActivityVisibility {
	return HOUSEKEEPING_ACTIVITY.has(type) ? 'housekeeping' : 'substance';
}

// ── Interpretations and briefs ─────────────────────────────────────────────

/**
 * What a `messageInterpretations` row was read from: an inbound Postbox
 * message (`mail`), a team inbound message (`inbound`), a sent Postbox message
 * (`outboundMail`) or a finalized team send (`teamReply`).
 */
export const INTERPRETATION_SOURCE_KINDS = [
	'mail',
	'inbound',
	'outboundMail',
	'teamReply',
] as const;
/** @public Contract type for the thread brief lanes. */
export type InterpretationSourceKind = (typeof INTERPRETATION_SOURCE_KINDS)[number];

export const INTERPRETATION_STATUSES = ['complete', 'partial', 'failed', 'skipped'] as const;
/** @public Contract type for the thread brief lanes. */
export type InterpretationStatus = (typeof INTERPRETATION_STATUSES)[number];

export const INTERPRETATION_SKIP_REASONS = [
	'short',
	'bulk',
	'security',
	'undecryptable',
	'ineligible',
] as const;
/** @public Contract type for the thread brief lanes. */
export type InterpretationSkipReason = (typeof INTERPRETATION_SKIP_REASONS)[number];

/** `none` = no interpretation at all: the thread opens on Conversation. */
export const BRIEF_COMPLETENESS = ['complete', 'partial', 'pending', 'none'] as const;
/** @public Contract type for the thread brief lanes. */
export type BriefCompleteness = (typeof BRIEF_COMPLETENESS)[number];

/** Segment kinds of `segmentMessage` (mailSegments.ts). */
export const MESSAGE_SEGMENT_KINDS = [
	'fresh',
	'quoted',
	'forwarded',
	'signature',
	'disclaimer',
] as const;
/** @public Contract type for the thread brief lanes. */
export type MessageSegmentKind = (typeof MESSAGE_SEGMENT_KINDS)[number];

// ── Item states and reactions (rules: threadBriefRules.ts) ──────────────────

/**
 * The user-facing item states (plan §5, labels in `components.brief.state.*`).
 * `addressedInDraft` is computed from a draft's response plan and never stored.
 */
export const ITEM_STATE_KEYS = [
	'open',
	'addressedInDraft',
	'answeredStillToDo',
	'markedDoneByYou',
	'done',
	'reportedDone',
	'declined',
	'replaced',
	'notTracked',
] as const;
export type ItemStateKey = (typeof ITEM_STATE_KEYS)[number];

/**
 * Every item reaction. None sends anything by itself: `attach` and
 * `proposeTimes` prepare a draft, `markDone` / `untrack` are the user's own
 * statements and can be undone.
 */
export const ITEM_REACTIONS = [
	'reply',
	'replyWithStance',
	'replyWithUpdate',
	'attach',
	'proposeTimes',
	'markPaid',
	'markDone',
	'nudge',
	'markReceived',
	'decline',
	'remind',
	'assign',
	'notARequest',
	'untrack',
] as const;
export type ItemReaction = (typeof ITEM_REACTIONS)[number];
