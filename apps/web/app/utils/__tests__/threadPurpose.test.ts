/**
 * What an opened conversation leads with: the brief's top open item with
 * whose turn it is, its due date and how many others wait behind it; the
 * latest line when a fully read thread only informs; and "review" whenever
 * the reading is missing, off or unfinished, so absence never reads as
 * nothing to do.
 */
import { describe, expect, it } from 'vitest';
import { resolveThreadPurpose, stripBesidePurpose } from '../threadPurpose';
import { briefView, DAY, item, T0 } from './threadBriefFixtures';
import { teamView } from './teamStreamFixtures';
import type { ReaderStrip } from '../postboxReaderStrip';

const noItems = {
	forYou: [],
	waitingOnOthers: [],
	unclear: [],
	counts: { forYou: 0, forTeam: 0, waitingOnOthers: 0, unclear: 0, closed: 0, hidden: 0 },
};

describe('resolveThreadPurpose, personal mailbox', () => {
	it('leads with the first item for you, its due date, source and the others', () => {
		const p = resolveThreadPurpose({ isAiOn: true, brief: briefView() });
		expect(p.kind).toBe('ask');
		expect(p.sentence).toBe('Approve the revised quote of €5,350');
		expect(p.who).toBe('forYou');
		expect(p.due).toBe(T0 + 2 * DAY);
		expect(p.source).toMatchObject({ ref: 'i_quote', evidence: { source: { id: 'm6' } } });
		expect(p.others.map((l) => [l.item.text, l.who])).toEqual([
			['Send the signed contract as a PDF', 'forYou'],
			['Jonas sends the new hero photos', 'waitingOnThem'],
		]);
		expect(p.more).toBe(2);
	});

	it('counts items on pages not loaded yet', () => {
		const brief = briefView();
		const p = resolveThreadPurpose({
			isAiOn: true,
			brief: { ...brief, counts: { ...brief.counts, forYou: 9 } },
		});
		expect(p.others).toHaveLength(2);
		expect(p.more).toBe(9);
	});

	it('waits on them when nothing is yours, and names an unclear item as needing review', () => {
		const waiting = resolveThreadPurpose({ isAiOn: true, brief: briefView({ forYou: [] }) });
		expect(waiting).toMatchObject({
			kind: 'ask',
			sentence: 'Jonas sends the new hero photos',
			who: 'waitingOnThem',
			due: null,
		});

		const unclear = resolveThreadPurpose({
			isAiOn: true,
			brief: briefView({
				...noItems,
				unclear: [item({ id: 'u1', text: 'Book the venue', responsibility: 'unclear' })],
			}),
		});
		expect(unclear).toMatchObject({ kind: 'ask', sentence: 'Book the venue', who: 'needsReview' });
	});

	it('skips closed items', () => {
		const p = resolveThreadPurpose({
			isAiOn: true,
			brief: briefView({
				forYou: [
					item({ id: 'd', text: 'Done already', status: 'done' }),
					item({ id: 'o', text: 'Still open' }),
				],
			}),
		});
		expect(p.sentence).toBe('Still open');
	});

	it('leads with the latest line when a fully read thread asks nothing', () => {
		const p = resolveThreadPurpose({ isAiOn: true, brief: briefView(noItems) });
		expect(p).toMatchObject({
			kind: 'update',
			sentence: 'Jonas likes design v2 and wants two changes.',
			item: null,
			source: { ref: 'latest-0' },
			more: 0,
		});
	});

	it('reviews a partial read with no items instead of calling it an update', () => {
		const p = resolveThreadPurpose({
			isAiOn: true,
			brief: briefView({ ...noItems, completeness: 'partial' }),
		});
		expect(p.kind).toBe('review');
	});

	it('reviews when AI is off, the brief is hidden, missing, loading or not read yet', () => {
		const brief = briefView();
		for (const input of [
			{ isAiOn: false, brief },
			{ isAiOn: true, isBriefShown: false, brief },
			{ isAiOn: true, brief: null },
			{ isAiOn: true, brief: undefined },
			{ isAiOn: true, brief: briefView({ ...noItems, completeness: 'none', latest: [] }) },
			{ isAiOn: true, brief: briefView({ ...noItems, latest: [] }) },
		]) {
			const p = resolveThreadPurpose(input);
			expect(p).toMatchObject({ kind: 'review', sentence: null, item: null, more: 0 });
		}
	});
});

describe('resolveThreadPurpose, team surfaces', () => {
	it('is open for the team unless someone holds it, and the viewer’s own item leads', () => {
		const view = teamView();
		const other = resolveThreadPurpose({ isAiOn: true, team: view, viewerId: 'user_ada' });
		expect(other).toMatchObject({
			kind: 'ask',
			sentence: 'Refund €129.00 for order #4471',
			who: 'assignedToOther',
		});
		expect(other.others.map((l) => l.who)).toEqual(['forTeam']);
		expect(other.more).toBe(1);

		const mine = resolveThreadPurpose({
			isAiOn: true,
			team: view,
			viewerId: 'user_mika',
		});
		expect(mine.who).toBe('assignedToYou');

		const unassigned = resolveThreadPurpose({
			isAiOn: true,
			team: teamView({ forTeam: [view.forTeam[1]!] }),
			viewerId: 'user_ada',
		});
		expect(unassigned).toMatchObject({
			sentence: 'Tell her whether to return the broken lamps',
			who: 'forTeam',
		});
	});

	it('never leads with an update, and reviews without a view or AI', () => {
		const empty = teamView({ forTeam: [], counts: noItems.counts });
		expect(resolveThreadPurpose({ isAiOn: true, team: empty }).kind).toBe('review');
		expect(resolveThreadPurpose({ isAiOn: true, team: null }).kind).toBe('review');
		expect(resolveThreadPurpose({ isAiOn: false, team: teamView() }).kind).toBe('review');
	});
});

describe('stripBesidePurpose', () => {
	const brief = briefView();
	const strip: ReaderStrip = {
		kind: 'brief',
		lead: { kind: 'latest', text: 'Jonas likes design v2 and wants two changes.' },
		owe: brief.forYou[0]!,
		waiting: brief.waitingOnOthers[0]!,
	};

	it('drops the item the header names and keeps the rest', () => {
		const purpose = resolveThreadPurpose({ isAiOn: true, brief });
		expect(stripBesidePurpose(strip, purpose)).toEqual({ ...strip, owe: null });
	});

	it('drops the latest line the header leads with, leaving the slim line', () => {
		const purpose = resolveThreadPurpose({ isAiOn: true, brief: briefView(noItems) });
		expect(stripBesidePurpose({ ...strip, owe: null, waiting: null }, purpose)).toEqual({
			kind: 'meta',
			note: null,
		});
	});

	it('leaves the strip alone under review', () => {
		const purpose = resolveThreadPurpose({ isAiOn: false, brief });
		expect(stripBesidePurpose(strip, purpose)).toEqual(strip);
	});
});
