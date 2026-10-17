/**
 * The calm reader's strip (read on arrival §3): which one element sits under
 * the header for each state of the brief, and the gist adapters that stand in
 * until lane arrival exposes the gist.
 */
import { describe, expect, it } from 'vitest';
import {
	briefHasContent,
	gistLine,
	readerGistOf,
	resolveReaderStrip,
	rowGistOf,
	stripItemActions,
} from '../postboxReaderStrip';
import { briefView, item } from './threadBriefFixtures';
import type { BriefTopRow } from '../../../../api/convex/mail/interpret/briefTop';

const gist = { quotes: ['Your parcel was delivered to the neighbour at no. 14.'] };
const base = { isShared: false, gist: null };

describe('resolveReaderStrip', () => {
	it('leads with the latest line, the first open item you owe and the first you wait on', () => {
		const strip = resolveReaderStrip({ ...base, brief: briefView() });
		expect(strip.kind).toBe('brief');
		if (strip.kind !== 'brief') return;
		expect(strip.lead).toEqual({
			kind: 'latest',
			text: 'Jonas likes design v2 and wants two changes.',
		});
		expect(strip.owe?.id).toBe('i_quote');
		expect(strip.waiting?.id).toBe('i_photos');
	});

	it('skips items that are no longer open', () => {
		const strip = resolveReaderStrip({
			...base,
			brief: briefView({
				forYou: [
					item({ id: 'i_done', text: 'Done already', status: 'done' }),
					item({ id: 'i_open', text: 'Still open' }),
				],
				waitingOnOthers: [],
			}),
		});
		expect(strip.kind === 'brief' && strip.owe?.id).toBe('i_open');
		expect(strip.kind === 'brief' && strip.waiting).toBeNull();
	});

	it('quotes the gist when the brief has items but no latest line', () => {
		const strip = resolveReaderStrip({ ...base, gist, brief: briefView({ latest: [] }) });
		expect(strip.kind === 'brief' && strip.lead).toEqual({ kind: 'gist', gist });
	});

	it('keeps the items of a fenced brief, with no lead', () => {
		const strip = resolveReaderStrip({
			...base,
			brief: briefView({
				latest: undefined,
				gap: { reason: 'stale', interpretedMessages: 1, totalMessages: 1 },
			}),
		});
		expect(strip.kind).toBe('brief');
		expect(strip.kind === 'brief' && strip.lead).toBeNull();
	});

	it('shows gist-depth mail as the gist line alone', () => {
		const strip = resolveReaderStrip({
			...base,
			gist,
			brief: briefView({ latest: [], forYou: [], waitingOnOthers: [] }),
		});
		expect(strip).toEqual({ kind: 'gist', gist });
	});

	it('has no strip while the brief loads, and never a skeleton', () => {
		expect(resolveReaderStrip({ ...base, brief: undefined })).toEqual({
			kind: 'meta',
			note: null,
		});
		expect(resolveReaderStrip({ ...base, brief: null })).toEqual({ kind: 'meta', note: null });
	});

	it('says quietly that this open reads the thread, and nothing more while a brief is pending', () => {
		expect(
			resolveReaderStrip({
				...base,
				brief: briefView({ completeness: 'pending', deferredSources: 2 }),
			})
		).toEqual({ kind: 'meta', note: 'reading' });
		expect(resolveReaderStrip({ ...base, brief: briefView({ completeness: 'pending' }) })).toEqual({
			kind: 'meta',
			note: null,
		});
		// With read on arrival on, a pending brief is being read right now.
		expect(
			resolveReaderStrip({
				...base,
				isReadOnArrival: true,
				brief: briefView({ completeness: 'pending' }),
			})
		).toEqual({ kind: 'meta', note: 'reading' });
		// An untouched thread is not being read, preference or not (Sol r1 F10).
		expect(
			resolveReaderStrip({
				...base,
				isReadOnArrival: true,
				brief: briefView({ completeness: 'none', latest: [] }),
			})
		).toEqual({ kind: 'meta', note: null });
		// With AI off nothing is read, deferred sources included.
		expect(
			resolveReaderStrip({
				...base,
				isAiOn: false,
				isReadOnArrival: true,
				brief: briefView({ completeness: 'pending', deferredSources: 2 }),
			})
		).toEqual({ kind: 'meta', note: null });
		expect(
			resolveReaderStrip({
				...base,
				isReadOnArrival: false,
				brief: briefView({ completeness: 'pending' }),
			})
		).toEqual({ kind: 'meta', note: null });
	});

	it('has no strip for count or none depth, or all skipped sources (nothing read, no gist)', () => {
		const empty = briefView({ latest: [], forYou: [], waitingOnOthers: [] });
		expect(resolveReaderStrip({ ...base, brief: empty })).toEqual({ kind: 'meta', note: null });
		expect(
			resolveReaderStrip({ ...base, brief: briefView({ completeness: 'none', latest: [] }) })
		).toEqual({ kind: 'meta', note: null });
	});

	it('has no strip where the original is the primary view, or in a team inbox', () => {
		for (const reason of ['short', 'security'] as const) {
			const brief = briefView({ gap: { reason, interpretedMessages: 1, totalMessages: 1 } });
			expect(resolveReaderStrip({ ...base, brief }).kind).toBe('meta');
		}
		expect(resolveReaderStrip({ ...base, isShared: true, brief: briefView() }).kind).toBe('meta');
	});
});

describe('gist adapters', () => {
	it('reads the spans brief.get will carry, with the message they came from', () => {
		const brief = {
			...briefView(),
			gist: {
				spans: [
					{ segmentId: 's0', quote: ' Delivered. ' },
					{ segmentId: 's1', quote: 'Signed by K.' },
				],
				messageId: 'm2',
			},
		};
		expect(readerGistOf(brief)).toEqual({
			quotes: ['Delivered.', 'Signed by K.'],
			messageId: 'm2',
		});
	});

	it('reads nothing from a brief without a gist, or with only blank spans', () => {
		expect(readerGistOf(briefView())).toBeNull();
		expect(readerGistOf({ ...briefView(), gist: { spans: [] } })).toBeNull();
		expect(
			readerGistOf({ ...briefView(), gist: { spans: [{ segmentId: 's0', quote: '  ' }] } })
		).toBeNull();
		expect(readerGistOf(undefined)).toBeNull();
	});

	it('reads a list row gist from briefTop', () => {
		const top = { mode: 'brief', forYou: 0, waiting: 0, isReplyNeeded: false } as BriefTopRow;
		expect(rowGistOf({ ...top, gist: { text: ' Payout of €2,410.00 arrives tomorrow ' } })).toBe(
			'Payout of €2,410.00 arrives tomorrow'
		);
		expect(rowGistOf(top)).toBeNull();
		expect(rowGistOf(undefined)).toBeNull();
	});
});

describe('gistLine', () => {
	it('joins the spans and keeps a short gist whole', () => {
		expect(gistLine({ quotes: ['Delivered.', 'Signed by K.'] })).toBe('Delivered. … Signed by K.');
	});

	it('cuts a long gist at a word boundary with an ellipsis, within 160 characters', () => {
		const words = Array.from({ length: 40 }, (_, i) => `word${i}`).join(' ');
		const line = gistLine({ quotes: [words] });
		expect(line.length).toBeLessThanOrEqual(160);
		expect(line.endsWith('…')).toBe(true);
		expect(words.startsWith(line.slice(0, -1))).toBe(true);
		expect(words.charAt(line.length - 1)).toBe(' ');
	});

	it('cuts one over-long word mid-word rather than dropping it', () => {
		const line = gistLine({ quotes: ['x'.repeat(300)] });
		expect(line).toBe(`${'x'.repeat(159)}…`);
	});
});

describe('briefHasContent (Full brief)', () => {
	const empty = briefView({
		latest: [],
		forYou: [],
		waitingOnOthers: [],
		unclear: [],
		standing: undefined,
		activity: [],
		files: [],
		participants: [],
		counts: { forYou: 0, forTeam: 0, waitingOnOthers: 0, unclear: 0, closed: 0, hidden: 0 },
	});

	it('is true for content the strip never shows', () => {
		expect(briefHasContent(empty)).toBe(false);
		expect(briefHasContent({ ...empty, unclear: [item({ id: 'i_u', text: 'Who books?' })] })).toBe(
			true
		);
		expect(briefHasContent({ ...empty, counts: { ...empty.counts, closed: 2 } })).toBe(true);
		expect(briefHasContent({ ...empty, standing: briefView().standing })).toBe(true);
		expect(briefHasContent({ ...empty, activity: briefView().activity })).toBe(true);
		expect(
			briefHasContent({
				...empty,
				participants: [{ email: 'lena@studio.example', isUs: false, role: 'from' }],
			})
		).toBe(true);
	});

	it('is false with no brief, or nothing interpreted', () => {
		expect(briefHasContent(null)).toBe(false);
		expect(briefHasContent(briefView({ completeness: 'none' }))).toBe(false);
	});

	it('does not count the people alone while the brief is still pending', () => {
		const people = {
			...empty,
			participants: [{ email: 'lena@studio.example', isUs: false, role: 'from' as const }],
		};
		expect(briefHasContent({ ...people, completeness: 'pending' })).toBe(false);
		// Anything read so far still opens it.
		expect(
			briefHasContent({ ...people, completeness: 'pending', activity: briefView().activity })
		).toBe(true);
	});
});

describe('stripItemActions', () => {
	it('offers Track and Not a request on a proposal, Reply and Mark done otherwise', () => {
		expect(stripItemActions({ verify: 'proposal' })).toEqual(['confirmProposal', 'notARequest']);
		expect(stripItemActions({ verify: 'passed' })).toEqual(['reply', 'markDone']);
	});
});
