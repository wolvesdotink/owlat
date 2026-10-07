/**
 * The brief's deterministic projection (SPEC §4 `brief.ts`), pure: already
 * unsealed rows in, the `ThreadBriefView` out. `briefRead.ts` loads and opens
 * the rows; `brief.ts get` wires the two together.
 *
 * Lists:
 *   - "For you" (brief) / "For the team" (actions): responsibility `us`;
 *   - "Waiting on others": `them`;
 *   - "Unclear": `unclear` (the UI treats it like `us`).
 * Each list holds the open items in `compareForYou` order (due date, facet
 * risk, age), then the items closed in the last 30 days newest first, so a
 * "Done" / "Marked done by you" state can still be seen and undone. Untracked
 * items are only counted (`counts.hidden`, behind "Show hidden").
 */

import type { Id } from '../../_generated/dataModel';
import type { BriefCompleteness, InterpretMode, ItemStatus } from '@owlat/shared/threadBrief';
import { compareForYou, itemStateKey, primaryReaction } from '@owlat/shared/threadBriefRules';
import type { ThreadRef } from '../../lib/validators/threadRef';
import type {
	ActivityView,
	BriefItemView,
	BriefModeView,
	FactView,
	FileView,
	LatestLineView,
	ParticipantView,
	ThreadBriefView,
} from './briefShape';
import { CLOSED_ITEM_LOOKBACK_MS } from './schema';

/** An item as the projection needs it: the view minus the derived fields. */
export type OpenedItem = Omit<BriefItemView, 'stateKey' | 'primaryReaction' | 'isNew'>;

export type GapReason = NonNullable<NonNullable<ThreadBriefView['gap']>['reason']>;

export interface ProjectionInput {
	threadRef: ThreadRef;
	mode: InterpretMode;
	interpretationRevision: number;
	completeness: BriefCompleteness;
	items: OpenedItem[];
	facts: FactView[];
	overview?: string;
	latest?: LatestLineView[];
	activity: ActivityView[];
	participants: ParticipantView[];
	files: FileView[];
	sinceLastSeen?: {
		newItemIds: Id<'threadItems'>[];
		changedItemIds: Id<'threadItems'>[];
		newActivityCount: number;
	};
	gap: { interpretedMessages: number; totalMessages: number; reason?: GapReason };
	/** The thread needs no reply: payment items offer "Mark paid" first. */
	isNoReplyNeeded?: boolean;
	/** The viewer's per-thread Overview / Conversation choice (brief mode). */
	viewOverride?: 'overview' | 'conversation';
	/** The brief's maintained item counters (accurate past one page). */
	itemCounts?: { us: number; them: number; unclear: number; closed: number; hidden: number };
	/** Paging of the item lists. */
	page?: { cursor: string | null; isDone: boolean; isClosedTruncated: boolean };
	/** Each interpreted message's own first "Latest update" line (brief mode). */
	messageLatest?: { messageId: string; text: string }[];
	/** Messages whose original stays open beside the brief (brief mode). */
	exactWording?: BriefModeView['exactWording'];
	now: number;
}

const CLOSED: ReadonlySet<ItemStatus> = new Set(['done', 'declined', 'superseded']);

/** Build the view. Pure. */
export function projectBrief(input: ProjectionInput): ThreadBriefView {
	const fresh = new Set<string>([
		...(input.sinceLastSeen?.newItemIds ?? []),
		...(input.sinceLastSeen?.changedItemIds ?? []),
	]);
	const view = (item: OpenedItem): BriefItemView => ({
		...item,
		stateKey: itemStateKey(item),
		primaryReaction: primaryReaction(item.intent, item.facets, item.responsibility, {
			noReplyNeeded: input.isNoReplyNeeded,
		}),
		isNew: fresh.has(item.id),
	});

	const listFor = (responsibility: BriefItemView['responsibility']): BriefItemView[] => {
		const mine = input.items.filter((i) => i.responsibility === responsibility);
		const open = mine
			.filter((i) => i.status === 'open')
			.sort((a, b) =>
				compareForYou(
					{ due: a.due, facets: a.facets, askedAt: a.askedAt, id: a.id },
					{ due: b.due, facets: b.facets, askedAt: b.askedAt, id: b.id }
				)
			);
		const closed = mine
			.filter((i) => CLOSED.has(i.status) && input.now - i.updatedAt <= CLOSED_ITEM_LOOKBACK_MS)
			.sort((a, b) => b.updatedAt - a.updatedAt);
		return [...open, ...closed].map(view);
	};

	const us = listFor('us');
	const waitingOnOthers = listFor('them');
	const unclear = listFor('unclear');
	const openCount = (list: BriefItemView[]) => list.filter((i) => i.status === 'open').length;
	const c = input.itemCounts;
	const counts = c
		? {
				forYou: input.mode === 'brief' ? c.us : 0,
				forTeam: input.mode === 'actions' ? c.us : 0,
				waitingOnOthers: c.them,
				unclear: c.unclear,
				closed: c.closed,
				hidden: c.hidden,
			}
		: {
				forYou: input.mode === 'brief' ? openCount(us) : 0,
				forTeam: input.mode === 'actions' ? openCount(us) : 0,
				waitingOnOthers: openCount(waitingOnOthers),
				unclear: openCount(unclear),
				closed: input.items.filter((i) => CLOSED.has(i.status)).length,
				hidden: input.items.filter((i) => i.status === 'untracked').length,
			};

	const showGap = input.completeness !== 'complete' || input.gap.reason !== undefined;
	const shared = {
		threadRef: input.threadRef,
		interpretationRevision: input.interpretationRevision,
		completeness: input.completeness,
		...(showGap ? { gap: input.gap } : {}),
		waitingOnOthers,
		unclear,
		activity: input.activity,
		counts,
		...(input.page ? { page: input.page } : {}),
	};

	if (input.mode === 'actions') return { mode: 'actions', ...shared, forTeam: us };

	const current = input.facts.filter((f) => f.status === 'current');
	return {
		mode: 'brief',
		...shared,
		...(input.latest && input.latest.length > 0 ? { latest: input.latest } : {}),
		...(current.length > 0 || input.overview
			? {
					standing: {
						facts: current,
						isConflicted: current.some((f) => f.conflictsWithId !== undefined),
						...(input.overview ? { overview: input.overview } : {}),
					},
				}
			: {}),
		forYou: us,
		participants: input.participants,
		files: input.files,
		...(input.sinceLastSeen ? { sinceLastSeen: input.sinceLastSeen } : {}),
		...(input.viewOverride ? { viewOverride: input.viewOverride } : {}),
		...(input.messageLatest && input.messageLatest.length > 0
			? { messageLatest: input.messageLatest }
			: {}),
		...(input.exactWording && input.exactWording.length > 0
			? { exactWording: input.exactWording }
			: {}),
	};
}

/** Which gap reason an extraction row explains, if any. Pure. */
export function gapReasonOf(row: {
	status: 'complete' | 'partial' | 'failed' | 'skipped';
	skipReason?: string;
	errorCode?: string;
}): GapReason | undefined {
	if (row.status === 'failed') return row.errorCode === 'ai_off' ? 'aiOff' : 'failed';
	if (row.status === 'partial') {
		return row.errorCode === 'overflow' || row.errorCode === 'too_long' ? 'tooLong' : 'failed';
	}
	if (row.status === 'skipped') {
		if (row.skipReason === 'undecryptable') return 'undecryptable';
		if (row.skipReason === 'security') return 'security';
		if (row.skipReason === 'short') return 'short';
		return 'ineligible';
	}
	return undefined;
}
