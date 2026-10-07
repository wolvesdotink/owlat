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
 * Pure and import-free: safe in the Convex V8 runtime, in Node actions and in
 * the browser.
 */

// ── Thread references ──────────────────────────────────────────────────────

/** `mail` = a Postbox `mailThreads` row, `team` = an agent inbox `conversationThreads` row. */
export const THREAD_REF_KINDS = ['mail', 'team'] as const;
export type ThreadRefKind = (typeof THREAD_REF_KINDS)[number];

/** `brief` for personal Postbox mailboxes, `actions` for every team surface (no latest, no facts). */
export const INTERPRET_MODES = ['brief', 'actions'] as const;
export type InterpretMode = (typeof INTERPRET_MODES)[number];

/** The two reader views of a personal thread. */
export const THREAD_VIEWS = ['overview', 'conversation'] as const;
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

/** The work. Edges: {@link LEGAL_STATUS_EDGES}. */
export const ITEM_STATUSES = ['open', 'done', 'declined', 'superseded', 'untracked'] as const;
export type ItemStatus = (typeof ITEM_STATUSES)[number];

/** What we told the other side. Independent of status. Edges: {@link isLegalDispositionEdge}. */
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
export type ItemVerifyState = (typeof ITEM_VERIFY_STATES)[number];

/** What a human correction on an item said. A correction is never flipped by a model proposal. */
export const ITEM_CORRECTION_KINDS = [
	'markedDone',
	'reopened',
	'untracked',
	'notARequest',
	'confirmed',
] as const;
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
export type ResponseStance = (typeof RESPONSE_STANCES)[number];

/** Per-item coverage of a draft. Shown as "Addressed in draft", never "Done". */
export const COVERAGE_VERDICTS = ['addressed', 'partial', 'notAddressed', 'skipped'] as const;
export type CoverageVerdict = (typeof COVERAGE_VERDICTS)[number];

/** Whole-plan verdict of a draft's self-check. `stale` = bound to an older draft hash or revision. */
export const PLAN_VERDICTS = ['pending', 'covered', 'gaps', 'stale'] as const;
export type PlanVerdict = (typeof PLAN_VERDICTS)[number];

export const DRAFT_REF_KINDS = ['mailDraft', 'inboundDraft'] as const;
export type DraftRefKind = (typeof DRAFT_REF_KINDS)[number];

// ── Facts ──────────────────────────────────────────────────────────────────

export const FACT_STATUSES = ['current', 'superseded', 'retracted'] as const;
export type FactStatus = (typeof FACT_STATUSES)[number];

export const FACT_VALUE_KINDS = ['date', 'money', 'ref', 'url', 'text'] as const;
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
export type InterpretationSourceKind = (typeof INTERPRETATION_SOURCE_KINDS)[number];

export const INTERPRETATION_STATUSES = ['complete', 'partial', 'failed', 'skipped'] as const;
export type InterpretationStatus = (typeof INTERPRETATION_STATUSES)[number];

export const INTERPRETATION_SKIP_REASONS = [
	'short',
	'bulk',
	'security',
	'undecryptable',
	'ineligible',
] as const;
export type InterpretationSkipReason = (typeof INTERPRETATION_SKIP_REASONS)[number];

/** `none` = no interpretation at all: the thread opens on Conversation. */
export const BRIEF_COMPLETENESS = ['complete', 'partial', 'pending', 'none'] as const;
export type BriefCompleteness = (typeof BRIEF_COMPLETENESS)[number];

/** Segment kinds of `segmentMessage` (mailSegments.ts). */
export const MESSAGE_SEGMENT_KINDS = [
	'fresh',
	'quoted',
	'forwarded',
	'signature',
	'disclaimer',
] as const;
export type MessageSegmentKind = (typeof MESSAGE_SEGMENT_KINDS)[number];

// ── Item state (what the user sees) ────────────────────────────────────────

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

export interface ItemStateInput {
	status: ItemStatus;
	disposition: ItemDisposition;
	completion?: ItemCompletion | null;
}

/**
 * Map an item's stored status, disposition and completion to the one state the
 * user sees. `addressedInDraft` is passed in by the caller that holds the
 * draft's coverage; it only applies to an open item.
 */
export function itemStateKey(
	item: ItemStateInput,
	options: { addressedInDraft?: boolean } = {}
): ItemStateKey {
	switch (item.status) {
		case 'untracked':
			return 'notTracked';
		case 'superseded':
			return 'replaced';
		case 'declined':
			return 'declined';
		case 'done':
			if (item.completion === 'asserted') return 'markedDoneByYou';
			if (item.completion === 'reported') return 'reportedDone';
			return 'done';
		case 'open':
			if (options.addressedInDraft) return 'addressedInDraft';
			if (
				item.disposition === 'answered' ||
				item.disposition === 'accepted' ||
				item.disposition === 'deferred'
			) {
				return 'answeredStillToDo';
			}
			return 'open';
	}
}

// ── Reactions ──────────────────────────────────────────────────────────────

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

export interface ReactionOptions {
	/** The thread needs no reply (informational mail that still carries items). */
	noReplyNeeded?: boolean;
}

interface ReactionChoice {
	primary: ItemReaction;
	also: readonly ItemReaction[];
}

/** Plan §5's table: one primary reaction per intent + facets, the rest in the ⋯ menu. */
function chooseReactions(
	intent: ItemIntent,
	facets: readonly ItemFacet[],
	responsibility: ItemResponsibility,
	options: ReactionOptions
): ReactionChoice {
	const has = (facet: ItemFacet) => facets.includes(facet);
	if (responsibility === 'them') {
		return { primary: 'nudge', also: ['markReceived', 'untrack'] };
	}
	switch (intent) {
		case 'promise':
			return { primary: 'markDone', also: ['replyWithUpdate', 'remind'] };
		case 'question':
			return { primary: 'reply', also: ['remind', 'notARequest'] };
		case 'decision':
			return { primary: 'replyWithStance', also: ['remind', 'assign'] };
		case 'request':
			if (has('payment') && options.noReplyNeeded) {
				return { primary: 'markPaid', also: ['remind', 'notARequest'] };
			}
			if (has('file')) return { primary: 'attach', also: ['reply', 'decline', 'markDone'] };
			if (has('meeting')) return { primary: 'proposeTimes', also: ['reply', 'decline'] };
			return { primary: 'reply', also: ['decline', 'markDone', 'remind'] };
	}
}

/** The one primary reaction an item shows (plan §5). */
export function primaryReaction(
	intent: ItemIntent,
	facets: readonly ItemFacet[],
	responsibility: ItemResponsibility,
	options: ReactionOptions = {}
): ItemReaction {
	return chooseReactions(intent, facets, responsibility, options).primary;
}

/** The reactions that sit in the item's ⋯ menu besides the primary one (plan §5 "Also in ⋯"). */
export function secondaryReactions(
	intent: ItemIntent,
	facets: readonly ItemFacet[],
	responsibility: ItemResponsibility,
	options: ReactionOptions = {}
): readonly ItemReaction[] {
	return chooseReactions(intent, facets, responsibility, options).also;
}

// ── Ordering and risk ──────────────────────────────────────────────────────

/** Higher = riskier. An item's risk is its riskiest facet. */
const FACET_RISK: Record<ItemFacet, number> = {
	payment: 6,
	signature: 5,
	access: 4,
	documentReview: 3,
	file: 2,
	meeting: 1,
	information: 0,
};

/** An item's risk: its riskiest facet, -1 with no facets. */
export function itemFacetRisk(facets: readonly ItemFacet[]): number {
	let risk = -1;
	for (const facet of facets) risk = Math.max(risk, FACET_RISK[facet]);
	return risk;
}

export interface ForYouSortable {
	/** `due.at` (ms epoch) when the due phrase resolved to a date. */
	due?: { at?: number | null } | null;
	facets: readonly ItemFacet[];
	/** When the item was first asked (message date of its first evidence), ms epoch. */
	askedAt: number;
	/** Final tie-break, so the order is total and stable. */
	id?: string;
}

/**
 * The "For you" order: earliest due date first (undated last), then riskier
 * facets, then older items first. Ties fall back to `id`.
 */
export function compareForYou(a: ForYouSortable, b: ForYouSortable): number {
	const dueA = a.due?.at ?? Number.POSITIVE_INFINITY;
	const dueB = b.due?.at ?? Number.POSITIVE_INFINITY;
	if (dueA !== dueB) return dueA < dueB ? -1 : 1;
	const risk = itemFacetRisk(b.facets) - itemFacetRisk(a.facets);
	if (risk !== 0) return risk;
	if (a.askedAt !== b.askedAt) return a.askedAt - b.askedAt;
	const idA = a.id ?? '';
	const idB = b.id ?? '';
	return idA < idB ? -1 : idA > idB ? 1 : 0;
}

const CONSEQUENTIAL_FACETS: ReadonlySet<ItemFacet> = new Set<ItemFacet>([
	'payment',
	'signature',
	'access',
]);

export interface ConsequentialInput {
	intent: ItemIntent;
	facets: readonly ItemFacet[];
	amount?: unknown;
	due?: unknown;
}

/**
 * Whether an item proposal goes through the verifier (SPEC §4 verify): money,
 * signature or access, a promise, a stated amount, or a deadline. Ownership,
 * closing transitions and fact supersession are verified as well; that is
 * decided per claim kind by the verifier, not by this item test.
 */
export function isConsequential(item: ConsequentialInput): boolean {
	if (item.intent === 'promise') return true;
	if (item.amount != null || item.due != null) return true;
	return item.facets.some((facet) => CONSEQUENTIAL_FACETS.has(facet));
}

// ── Lifecycle edges ────────────────────────────────────────────────────────

/** The reducer's legal status edges. `superseded` is terminal; `untracked → open` is user-only. */
export const LEGAL_STATUS_EDGES: Readonly<Record<ItemStatus, readonly ItemStatus[]>> = {
	open: ['done', 'declined', 'superseded', 'untracked'],
	done: ['open'],
	declined: ['open'],
	superseded: [],
	untracked: ['open'],
};

/** Whether `actor` may move an item from `from` to `to`. A same-state "edge" is not an edge. */
export function isLegalStatusEdge(from: ItemStatus, to: ItemStatus, actor: ActivityActor): boolean {
	if (!LEGAL_STATUS_EDGES[from].includes(to)) return false;
	if (from === 'untracked' && actor !== 'user') return false;
	return true;
}

/**
 * Disposition edges (plan §5): `unanswered → answered | accepted | deferred |
 * declined`, and any → `failed` (the only send that carried it failed). Two
 * additions: a `failed` disposition is recomputed from the sends that remain
 * (back to `unanswered`, or to what a successful resend said), and a
 * `deferred` item can still be answered, accepted or declined later.
 */
export function isLegalDispositionEdge(from: ItemDisposition, to: ItemDisposition): boolean {
	if (from === to) return false;
	if (to === 'failed') return true;
	if (from === 'failed') return true;
	if (from === 'deferred') return to === 'answered' || to === 'accepted' || to === 'declined';
	return from === 'unanswered';
}
