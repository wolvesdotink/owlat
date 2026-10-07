/** Team stream entries and a team (actions) view for the team component tests. */
import type {
	TeamOpenItemsView,
	TeamStreamEntry,
} from '../../../../api/convex/mail/interpret/briefShape';
import { item, T0 } from '~/utils/__tests__/threadBriefFixtures';

export { item, T0 };

const MIN = 60_000;

export function email(
	id: string,
	at: number,
	preview = 'Hi, my lamp arrived broken.'
): TeamStreamEntry {
	return {
		kind: 'customerEmail',
		key: `email:${id}`,
		at,
		source: { kind: 'inbound', id: id as never },
		fromName: 'Ana Costa',
		fromEmail: 'ana@kestrel.example',
		preview,
	};
}

export function note(
	id: string,
	at: number,
	over: Partial<Extract<TeamStreamEntry, { kind: 'note' }>> = {}
): TeamStreamEntry {
	return {
		kind: 'note',
		key: `note:${id}`,
		at,
		noteSource: 'threadNote',
		noteId: id,
		authorId: 'user_mika',
		authorName: 'Mika',
		body: 'Courier damage again.',
		mentionedUserIds: [],
		isDeleted: false,
		reactions: [],
		...over,
	};
}

export function reply(
	id: string,
	at: number,
	over: Partial<Extract<TeamStreamEntry, { kind: 'teamReply' }>> = {}
): TeamStreamEntry {
	return {
		kind: 'teamReply',
		key: `reply:${id}`,
		at,
		authorUserId: 'user_mika',
		isAgent: false,
		status: 'sent',
		toName: 'Ana Costa',
		preview: 'Sorry about that, Ana.',
		body: 'Sorry about that, Ana. A replacement is on its way.',
		...over,
	};
}

export function activity(
	id: string,
	at: number,
	type: string,
	over: Partial<Extract<TeamStreamEntry, { kind: 'activity' }>> = {}
): TeamStreamEntry {
	return {
		kind: 'activity',
		key: `activity:${id}`,
		at,
		activity: {
			id: id as never,
			seq: 1,
			type: type as never,
			actor: { kind: 'system' },
			provenance: 'recorded',
			visibility: 'substance',
			eventAt: at,
		},
		...over,
	};
}

export function teamView(over: Partial<TeamOpenItemsView> = {}): TeamOpenItemsView {
	return {
		mode: 'actions',
		threadRef: { kind: 'team', id: 'th1' as never },
		interpretationRevision: 2,
		completeness: 'complete',
		waitingOnOthers: [],
		unclear: [],
		activity: [],
		counts: { forYou: 0, forTeam: 2, waitingOnOthers: 0, unclear: 0, closed: 0, hidden: 0 },
		forTeam: [
			item({
				id: 'i_refund',
				text: 'Refund €129.00 for order #4471',
				facets: ['payment'],
				assigneeUserId: 'user_mika',
				primaryReaction: 'reply',
				requester: { name: 'Ana Costa', isUs: false },
				askedAt: T0,
			}),
			item({
				id: 'i_return',
				text: 'Tell her whether to return the broken lamps',
				intent: 'question',
				primaryReaction: 'reply',
				askedAt: T0 + MIN,
			}),
		],
		...over,
	};
}
