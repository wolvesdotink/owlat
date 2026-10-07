/**
 * The brief's presentation rules: the ring per item state (plan §5), the ⋯
 * menu of a personal item, what a cite points at, the "Where things stand"
 * rows, the incomplete banners, and the one line a list row shows.
 */
import { describe, expect, it } from 'vitest';
import { briefRing, canUndo, menuReactions, resolveCite } from '../threadBriefItems';
import { factLabel, factRows } from '../threadBriefFacts';
import { briefBanners } from '../threadBriefBanners';
import { briefMoreChip, briefRowLatest, briefRowLine } from '../briefRowLine';
import { briefView, DAY, fact, item, T0 } from './threadBriefFixtures';

describe('briefRing', () => {
	it('draws each state as the plan shows it', () => {
		const open = item({ id: 'a', text: 'x' });
		expect(briefRing(open, 'open')).toBe('open');
		expect(briefRing(open, 'answeredStillToDo')).toBe('half');
		expect(briefRing(open, 'markedDoneByYou')).toBe('done');
		expect(briefRing(open, 'reportedDone')).toBe('done');
		expect(briefRing(open, 'declined')).toBe('declined');
		expect(briefRing(open, 'replaced')).toBe('replaced');
		expect(briefRing({ ...open, responsibility: 'them' }, 'open')).toBe('waiting');
		expect(briefRing({ ...open, verify: 'proposal' }, 'open')).toBe('proposal');
	});

	it('lets the viewer take back only their own statements', () => {
		expect(canUndo('markedDoneByYou')).toBe(true);
		expect(canUndo('notTracked')).toBe(true);
		expect(canUndo('reportedDone')).toBe(false);
	});
});

describe('menuReactions', () => {
	it('lists the rest of the reactions, never the primary, and no team verb', () => {
		const decision = item({
			id: 'd',
			text: 'x',
			intent: 'decision',
			primaryReaction: 'replyWithStance',
		});
		expect(menuReactions(decision)).toEqual(['remind']);
		expect(menuReactions(decision, { isTeam: true })).toEqual(['remind', 'assign']);
		const file = item({ id: 'f', text: 'x', facets: ['file'], primaryReaction: 'attach' });
		expect(menuReactions(file)).toEqual(['reply', 'decline', 'markDone']);
	});
});

describe('resolveCite', () => {
	const brief = briefView();
	it('finds an item, a fact or a latest line and the message it quotes', () => {
		expect(resolveCite(brief, { ref: 'i_contract', quoteIndex: 0 })).toEqual({
			messageId: 'm6',
			quote: 'Send the signed contract as a PDF',
			label: 'Send the signed contract as a PDF',
		});
		expect(resolveCite(brief, { ref: 'f_new', quoteIndex: 0 })?.label).toBe(
			'Launch moved because of the board meeting'
		);
		expect(resolveCite(brief, { ref: 'latest-0', quoteIndex: 0 })?.quote).toBe('v2 looks great');
	});

	it('falls back to the first quote, and gives up on an unknown ref', () => {
		expect(resolveCite(brief, { ref: 'i_quote', quoteIndex: 5 })?.messageId).toBe('m6');
		expect(resolveCite(brief, { ref: 'nope', quoteIndex: 0 })).toBeNull();
	});
});

describe('factRows', () => {
	it('labels a fact by its entity and strikes the value it replaced', () => {
		expect(factLabel('["launch","date",""]')).toBe('Launch');
		expect(factLabel('quote|amount|')).toBe('Quote');
		const rows = factRows(briefView().standing!.facts, 'en-GB');
		expect(rows).toHaveLength(1);
		expect(rows[0]!.value).toBe('14 Nov');
		expect(rows[0]!.previous).toBe('31 Oct');
	});

	it('pairs conflicting statements instead of listing both', () => {
		const rows = factRows(
			[
				fact({
					id: 'a',
					key: '["delivery","date",""]',
					text: 'Thu',
					conflictsWithId: 'b' as never,
				}),
				fact({
					id: 'b',
					key: '["delivery","date",""]',
					text: 'Mon',
					conflictsWithId: 'a' as never,
				}),
			],
			'en'
		);
		expect(rows).toHaveLength(1);
		expect(rows[0]!.conflict?.fact.id).toBe('b');
	});
});

describe('briefBanners', () => {
	it('says how much of a partly read thread is in the overview', () => {
		const banners = briefBanners(
			briefView({
				completeness: 'partial',
				gap: { interpretedMessages: 2, totalMessages: 3, reason: 'tooLong' },
			})
		);
		expect(banners).toMatchObject([
			{
				key: 'partial',
				text: {
					key: 'components.brief.incomplete.partialReason.tooLong',
					params: { done: 2, total: 3 },
				},
				offersConversation: true,
			},
		]);
	});

	it('explains a missing overview, and shows short and security mail as written', () => {
		expect(briefBanners(null)[0]).toMatchObject({ key: 'none', offersConversation: true });
		expect(
			briefBanners(
				briefView({
					completeness: 'none',
					gap: { interpretedMessages: 0, totalMessages: 1, reason: 'aiOff' },
				})
			)[0]?.text
		).toBe('components.brief.incomplete.none.aiOff');
		expect(
			briefBanners(
				briefView({ gap: { interpretedMessages: 1, totalMessages: 1, reason: 'short' } })
			)[0]?.key
		).toBe('short');
		expect(
			briefBanners(
				briefView({ gap: { interpretedMessages: 1, totalMessages: 1, reason: 'security' } })
			)[0]?.tone
		).toBe('err');
	});

	it('notes the signed scope, and nothing for a complete brief', () => {
		expect(briefBanners(briefView())).toEqual([]);
		expect(briefBanners(briefView(), { isSigned: true }).map((b) => b.key)).toEqual(['signed']);
	});
});

describe('briefRowLine', () => {
	const top = {
		mode: 'brief' as const,
		forYou: 4,
		waiting: 1,
		top: {
			itemId: 'i' as never,
			responsibility: 'us' as const,
			text: { en: 'Approve the revised quote', de: 'Gib das neue Angebot frei' },
			dueAt: T0 + 2 * DAY,
		},
		latest: { en: 'Launch moved.', de: 'Der Launch ist verschoben.' },
		isReplyNeeded: true,
	};

	it('leads with the count for you, in the UI locale', () => {
		const line = briefRowLine(top, 'en', T0);
		expect(line).toMatchObject({
			leadKey: 'components.brief.row.forYou',
			count: 4,
			text: 'Approve the revised quote',
			isNoReplyNeeded: false,
			keepsSnippet: false,
		});
		expect(line?.due).toBeTruthy();
		expect(briefRowLine(top, 'de-DE', T0)?.text).toBe('Gib das neue Angebot frei');
		expect(briefRowLatest(top, 'en')).toBe('Launch moved.');
	});

	it('says "to do" with no reply needed, "waiting" for their items, and keeps the snippet when shared', () => {
		expect(briefRowLine({ ...top, isReplyNeeded: false }, 'en', T0)).toMatchObject({
			leadKey: 'components.brief.row.toDo',
			isNoReplyNeeded: true,
		});
		expect(
			briefRowLine({ ...top, forYou: 0, top: { ...top.top, responsibility: 'them' } }, 'en', T0)
		).toMatchObject({ leadKey: 'components.brief.row.waiting', count: 1, tone: 'info' });
		expect(briefRowLine({ ...top, mode: 'actions' }, 'en', T0)?.keepsSnippet).toBe(true);
	});

	it('says "waiting" from the list the top item heads, never from a zero count', () => {
		const waitingTop = {
			...top.top,
			bucket: 'waitingOnOthers' as const,
			responsibility: 'them' as const,
		};
		expect(briefRowLine({ ...top, top: waitingTop }, 'en', T0)?.leadKey).toBe(
			'components.brief.row.waiting'
		);
		// No for-you items counted, but the top item heads `forUs`: not "waiting".
		const usTop = { ...top.top, bucket: 'forUs' as const };
		expect(briefRowLine({ ...top, forYou: 0, top: usTop }, 'en', T0)?.leadKey).toBe(
			'components.brief.row.forYou'
		);
	});

	it('keeps the snippet when there is no open item', () => {
		expect(briefRowLine(undefined, 'en')).toBeNull();
		expect(briefRowLine({ ...top, forYou: 0, waiting: 0, top: undefined }, 'en')).toBeNull();
	});
});

describe('briefMoreChip', () => {
	it('is exact, with the zero and one edges', () => {
		expect(briefMoreChip(4)).toEqual({ key: 'components.brief.more', count: 3 });
		expect(briefMoreChip(2000)).toEqual({ key: 'components.brief.more', count: 1999 });
		expect(briefMoreChip(1)).toBeNull();
		expect(briefMoreChip(0)).toBeNull();
	});
});
