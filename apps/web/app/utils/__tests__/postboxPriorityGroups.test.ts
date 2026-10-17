/**
 * The Priority view's groups and one-line rows (read on arrival §3).
 */
import { describe, expect, it } from 'vitest';
import type { Placement } from '@owlat/shared/arrival';
import type { BriefTopRow } from '../../../../api/convex/mail/interpret/briefTop';
import {
	groupPriorityRows,
	priorityGroupOf,
	priorityRowLine,
	updatesFoldLine,
} from '../postboxPriorityGroups';

const NOW = new Date(2026, 9, 17, 12, 0);
const TODAY = new Date(2026, 9, 17, 9, 0).getTime();
const LAST_WEEK = new Date(2026, 9, 10, 9, 0).getTime();

function row(
	id: string,
	over: { placement?: Placement; category?: string; receivedAt?: number; flagSeen?: boolean } = {}
) {
	return { _id: id, threadId: `t-${id}`, receivedAt: TODAY, flagSeen: false, ...over };
}

const ids = (rows: { _id: string }[]) => rows.map((r) => r._id);

describe('groupPriorityRows', () => {
	it('groups by placement within the Today window', () => {
		const g = groupPriorityRows(
			[
				row('ask', { placement: 'needs_me' }),
				row('venue', { placement: 'today' }),
				row('bahn', { placement: 'updates', category: 'notification' }),
				row('news', { placement: 'digest', category: 'newsletter' }),
				row('promo', { placement: 'digest', category: 'promotion' }),
			],
			{ now: NOW }
		);
		expect(ids(g.needsMe)).toEqual(['ask']);
		expect(ids(g.today)).toEqual(['venue']);
		expect(ids(g.updates)).toEqual(['bahn']);
		expect(ids(g.digest)).toEqual(['news', 'promo']);
		expect(g.autoFiled).toEqual([]);
	});

	it('groups every explicit placement at any age; only unplaced threads keep the window', () => {
		const old = { receivedAt: LAST_WEEK, flagSeen: true };
		const g = groupPriorityRows(
			[
				row('old-ask', { placement: 'needs_me', ...old }),
				row('old-update', { placement: 'updates', ...old }),
				row('old-news', { placement: 'digest', ...old }),
				row('old-today', { placement: 'today', ...old }),
				row('old-legacy', old),
				row('filed', { placement: 'archived' }),
			],
			{ now: NOW }
		);
		expect(ids(g.needsMe)).toEqual(['old-ask']);
		expect(ids(g.updates)).toEqual(['old-update']);
		expect(ids(g.digest)).toEqual(['old-news']);
		expect(ids(g.today)).toEqual(['old-today']);
		expect(ids(g.older)).toEqual(['old-legacy', 'filed']);
	});

	it('leaves a queued thread out of every group, past mail included', () => {
		const old = { receivedAt: LAST_WEEK, flagSeen: true };
		const g = groupPriorityRows(
			[
				row('old-queued', old),
				row('old-placed', { placement: 'updates', ...old }),
				row('old-free', old),
			],
			{ now: NOW, queuedThreadIds: new Set(['t-old-queued', 't-old-placed']) }
		);
		expect(ids(g.older)).toEqual(['old-free']);
		expect(g.updates).toEqual([]);
	});

	it('counts each conversation once, by its newest row, across pages', () => {
		const page1 = [
			{ ...row('news-2', { placement: 'digest' }), threadId: 't-news' },
			{ ...row('bahn-2', { placement: 'updates' }), threadId: 't-bahn' },
		];
		const page2 = [
			{ ...row('news-1', { placement: 'digest' }), threadId: 't-news' },
			{ ...row('bahn-1', { placement: 'updates' }), threadId: 't-bahn' },
			{ ...row('bahn-0', { placement: 'updates', receivedAt: LAST_WEEK }), threadId: 't-bahn' },
		];
		const g = groupPriorityRows([...page1, ...page2], { now: NOW });
		expect(ids(g.digest)).toEqual(['news-2']);
		expect(ids(g.updates)).toEqual(['bahn-2']);
		expect(g.older).toEqual([]);
	});

	it('falls back to the category grouping for rows without a placement', () => {
		const g = groupPriorityRows(
			[row('person', { category: 'person' }), row('receipt', { category: 'receipt' })],
			{ now: NOW }
		);
		expect(ids(g.today)).toEqual(['person']);
		expect(ids(g.autoFiled)).toEqual(['receipt']);
		expect(g.autoFiledCounts).toEqual({ receipt: 1 });
	});

	it('shows a thread the Reply Queue lists once, as the queue row', () => {
		const g = groupPriorityRows(
			[row('a', { placement: 'needs_me' }), row('b', { placement: 'today' }), row('c')],
			{ now: NOW, queuedThreadIds: new Set(['t-a', 't-b', 't-c']) }
		);
		expect([...g.needsMe, ...g.today, ...g.updates]).toEqual([]);
	});

	it('maps a placement to its group', () => {
		expect(priorityGroupOf('needs_me')).toBe('needsMe');
		expect(priorityGroupOf('updates')).toBe('updates');
		expect(priorityGroupOf('digest')).toBe('digest');
		expect(priorityGroupOf(undefined)).toBe('today');
	});
});

function top(over: Partial<BriefTopRow> = {}): BriefTopRow {
	return { mode: 'brief', forYou: 1, waiting: 0, isReplyNeeded: false, ...over };
}
const ASK = {
	itemId: 'i1' as never,
	bucket: 'forUs' as const,
	responsibility: 'us' as const,
	text: { en: 'Signed quote by Friday', de: 'Unterschriebenes Angebot bis Freitag' },
};
const LEAD = { en: 'Shared the venue shortlist', de: 'Hat die Auswahl geteilt' };

describe('priorityRowLine', () => {
	const subject = 'Re: Print run';

	it('reads the ask first in Needs you, the lead first elsewhere', () => {
		const row = { subject, receivedAt: TODAY, briefTop: top({ top: ASK, latest: LEAD }) };
		expect(priorityRowLine(row, 'needsMe', 'en').text).toBe('Signed quote by Friday');
		expect(priorityRowLine(row, 'today', 'en')).toMatchObject({
			text: 'Shared the venue shortlist',
			source: 'lead',
		});
		expect(priorityRowLine(row, 'today', 'de').text).toBe('Hat die Auswahl geteilt');
	});

	it('falls back to the gist, then the subject', () => {
		const gistRow = {
			subject,
			receivedAt: TODAY,
			briefTop: { ...top({ forYou: 0 }), gist: { text: 'Payout of €2,410.00 arrives tomorrow' } },
		};
		expect(priorityRowLine(gistRow, 'updates', 'en')).toMatchObject({
			text: 'Payout of €2,410.00 arrives tomorrow',
			source: 'gist',
			state: { kind: 'time' },
		});
		expect(priorityRowLine({ subject, receivedAt: TODAY }, 'today', 'en')).toMatchObject({
			text: subject,
			source: 'subject',
		});
	});

	it('says a due date, "reply", "waiting" or the time', () => {
		const due = Date.UTC(2026, 9, 19, 12);
		const dueRow = { subject, receivedAt: TODAY, briefTop: top({ top: { ...ASK, dueAt: due } }) };
		expect(priorityRowLine(dueRow, 'needsMe', 'en', { now: NOW.getTime() }).state.kind).toBe('due');
		// The viewer turned the brief off: the subject, the state kept.
		expect(
			priorityRowLine(dueRow, 'needsMe', 'en', { now: NOW.getTime(), showBrief: false })
		).toMatchObject({ source: 'subject', state: { kind: 'due' } });
		const replyRow = { subject, receivedAt: TODAY, briefTop: top({ isReplyNeeded: true }) };
		expect(priorityRowLine(replyRow, 'today', 'en').state).toEqual({ kind: 'reply' });
		const waiting = {
			subject,
			receivedAt: TODAY,
			briefTop: top({ top: { ...ASK, bucket: 'waitingOnOthers', responsibility: 'them' } }),
		};
		expect(priorityRowLine(waiting, 'today', 'en').state).toEqual({ kind: 'waiting' });
		expect(priorityRowLine({ subject, receivedAt: TODAY }, 'today', 'en').state).toEqual({
			kind: 'time',
		});
	});
});

describe('updatesFoldLine', () => {
	const from = (fromName: string) => ({ fromName, fromAddress: `${fromName}@example.com` });

	it('names one sender, two, or two and the rest', () => {
		expect(updatesFoldLine([])).toBeNull();
		expect(updatesFoldLine([from('GitHub'), from('GitHub')])).toEqual({
			key: 'postbox.priority.updates.foldOne',
			params: { count: 2, a: 'GitHub' },
			count: 2,
		});
		expect(updatesFoldLine([from('GitHub'), from('Hetzner')])?.key).toBe(
			'postbox.priority.updates.foldTwo'
		);
		expect(updatesFoldLine([from('GitHub'), from('Hetzner'), from('Bank')])).toMatchObject({
			key: 'postbox.priority.updates.foldOneOther',
			params: { count: 3, a: 'GitHub', b: 'Hetzner', others: 1 },
		});
		expect(updatesFoldLine(['GitHub', 'Hetzner', 'Bank', 'DHL', 'Bahn'].map(from))).toMatchObject({
			key: 'postbox.priority.updates.foldOthers',
			params: { others: 3 },
		});
	});

	it('names a sender without a display name by address', () => {
		expect(updatesFoldLine([{ fromAddress: 'noreply@github.com' }])?.params.a).toBe(
			'noreply@github.com'
		);
	});
});
