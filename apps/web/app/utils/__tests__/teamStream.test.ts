/**
 * The team stream's pure rules (utils/teamStream, utils/teamStreamText): pages
 * merged into one order, new actions grouped into one line, the "New"
 * divider, the composer's `#` link, and where a host that renders the emails
 * puts the notes.
 */
import { describe, expect, it } from 'vitest';
import {
	activeItemQuery,
	buildStreamRows,
	countMentionsOf,
	linkableItems,
	matchItems,
	mergeStreamPages,
	noteCountsByItem,
	placeStreamExtras,
	removeItemQuery,
} from '~/utils/teamStream';
import { systemLineText } from '~/utils/teamStreamText';
import { activity, email, item, note, reply, T0, teamView } from './teamStreamFixtures';

const MIN = 60_000;

describe('mergeStreamPages', () => {
	it('puts the pages into one order and keeps the newest copy of an entry', () => {
		const newest = [note('n2', T0 + 2 * MIN, { body: 'edited' }), email('e2', T0 + 3 * MIN)];
		const older = [email('e1', T0), note('n2', T0 + 2 * MIN, { body: 'stale' })];
		const merged = mergeStreamPages([newest, older, undefined]);
		expect(merged.map((e) => e.key)).toEqual(['email:e1', 'note:n2', 'email:e2']);
		expect(merged[1]).toMatchObject({ body: 'edited' });
	});
});

describe('buildStreamRows', () => {
	it('reads new actions noted together as one line', () => {
		const rows = buildStreamRows([
			email('e1', T0),
			activity('a1', T0 + 1000, 'item_opened'),
			activity('a2', T0 + 2000, 'item_opened'),
			note('n1', T0 + 10 * MIN),
			activity('a3', T0 + 11 * MIN, 'item_opened'),
		]);
		expect(rows.map((r) => r.kind)).toEqual(['entry', 'opened', 'entry', 'opened']);
		expect(rows[1]).toMatchObject({ entries: [{ key: 'activity:a1' }, { key: 'activity:a2' }] });
	});

	it('puts "New" before the first entry past the saved place that someone else wrote', () => {
		const entries = [
			email('e1', T0),
			note('mine', T0 + MIN, { authorId: 'me' }),
			note('theirs', T0 + 2 * MIN),
		];
		const rows = buildStreamRows(entries, {
			seenPosition: { at: T0, key: 'email:e1' },
			viewerId: 'me',
		});
		expect(rows.map((r) => r.key)).toEqual([
			'email:e1',
			'note:mine',
			'new:note:theirs',
			'note:theirs',
		]);
		expect(buildStreamRows(entries).some((r) => r.kind === 'newDivider')).toBe(false);
	});
});

describe('the # item link', () => {
	it('finds the fragment typed after #, and removes it once an item is picked', () => {
		expect(activeItemQuery('refund is fine #ref', 19)).toEqual({ start: 15, fragment: 'ref' });
		expect(activeItemQuery('#', 1)).toEqual({ start: 0, fragment: '' });
		expect(activeItemQuery('order#4471', 10)).toBeNull();
		expect(activeItemQuery('see #a b', 8)).toBeNull();
		expect(removeItemQuery('ok #ref then', 3, 7)).toEqual({ text: 'ok  then', caret: 3 });
	});

	it('offers the open items, the team first, matched on their text', () => {
		const view = teamView({
			unclear: [item({ id: 'u1', text: 'Who pays the courier?', responsibility: 'unclear' })],
		});
		const items = linkableItems(view);
		expect(items.map((i) => i.id)).toEqual(['i_refund', 'i_return', 'u1']);
		expect(matchItems(items, 'REFUND').map((i) => i.id)).toEqual(['i_refund']);
		expect(linkableItems(null)).toEqual([]);
	});
});

describe('counts', () => {
	it('counts live notes per linked item and the notes that mention someone', () => {
		const entries = [
			note('n1', T0, { threadItemId: 'i_refund' as never, mentionedUserIds: ['me'] }),
			note('n2', T0 + 1, { threadItemId: 'i_refund' as never }),
			note('n3', T0 + 2, { threadItemId: 'i_refund' as never, isDeleted: true }),
		];
		expect(noteCountsByItem(entries).get('i_refund')).toBe(2);
		expect(countMentionsOf(entries, 'me')).toBe(1);
		expect(countMentionsOf(entries, null)).toBe(0);
	});
});

describe('placeStreamExtras', () => {
	it('puts notes and system lines after the email they follow', () => {
		const placed = placeStreamExtras(
			[
				note('early', T0 - MIN),
				email('e1', T0),
				reply('r1', T0 + MIN),
				note('n1', T0 + 2 * MIN),
				email('unloaded', T0 + 3 * MIN),
				activity('a1', T0 + 4 * MIN, 'send_held'),
			],
			(entry) => (entry.kind === 'customerEmail' && entry.key !== 'email:unloaded' ? 'e1' : null)
		);
		expect(placed.leading.map((e) => e.key)).toEqual(['note:early']);
		expect(placed.after.get('e1')?.map((e) => e.key)).toEqual(['note:n1', 'activity:a1']);
	});
});

describe('systemLineText', () => {
	const t = (key: string, params?: Record<string, unknown>) =>
		`${key}${params ? JSON.stringify(params) : ''}`;
	const memberName = (id: string) => (id === 'user_mika' ? 'Mika' : id);

	it('names the action, the way it closed and who did it', () => {
		const closed = activity('a1', T0, 'item_closed', {
			itemText: 'Send a replacement lamp',
		}) as never as Extract<ReturnType<typeof activity>, { kind: 'activity' }>;
		closed.activity.actor = { kind: 'user', id: 'user_mika' };
		closed.activity.delta = { statusTo: 'untracked' };
		expect(systemLineText([closed], { t, memberName })).toBe(
			'Mika · components.team.stream.system.item_closed_untracked{"item":"Send a replacement lamp"}'
		);
	});

	it('says how many actions were noted together, and falls back to the activity sentence', () => {
		const opened = [
			activity('a1', T0, 'item_opened'),
			activity('a2', T0, 'item_opened'),
		] as never[];
		expect(systemLineText(opened, { t, memberName })).toBe(
			'components.team.stream.system.openedMany{"count":2}'
		);
		const held = activity('h', T0, 'send_held') as never;
		expect(systemLineText([held], { t, memberName })).toBe(
			'components.brief.activity.type.send_held'
		);
	});
});
