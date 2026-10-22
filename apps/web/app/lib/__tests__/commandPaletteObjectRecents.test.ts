/**
 * The jump-back list's rules: newest first, one entry per record, ten at most,
 * namespaced per person and organization, tolerant of whatever storage holds,
 * and never offering the record on screen as the place to jump back to.
 */
import { describe, it, expect } from 'vitest';
import {
	MAX_OBJECT_RECENTS,
	type PaletteObjectRecent,
	jumpBackEntries,
	objectRecencyIndex,
	objectRecentKey,
	objectRecentsStorageKey,
	parseObjectRecents,
	pushObjectRecent,
} from '../commandPaletteObjectRecents';

function entry(
	id: string,
	openedAt: number,
	overrides: Partial<PaletteObjectRecent> = {}
): PaletteObjectRecent {
	return {
		kind: 'campaign',
		id,
		title: `Campaign ${id}`,
		href: `/dashboard/campaigns/${id}/edit`,
		openedAt,
		...overrides,
	};
}

describe('pushObjectRecent', () => {
	it('puts the newest open first and keeps one entry per record', () => {
		let list: PaletteObjectRecent[] = [];
		list = pushObjectRecent(list, entry('a', 1));
		list = pushObjectRecent(list, entry('b', 2));
		list = pushObjectRecent(list, entry('a', 3, { title: 'Renamed' }));
		expect(list.map((e) => [e.id, e.title, e.openedAt])).toEqual([
			['a', 'Renamed', 3],
			['b', 'Campaign b', 2],
		]);
	});

	it('tells records of different kinds apart even when their ids match', () => {
		const list = pushObjectRecent(
			[entry('x', 1)],
			entry('x', 2, { kind: 'contact', href: '/dashboard/audience/contacts/x' })
		);
		expect(list.map(objectRecentKey)).toEqual(['contact:x', 'campaign:x']);
	});

	it('folds a conversation recorded by its message into the same one recorded by its thread', () => {
		const conversation = (id: string, openedAt: number) =>
			entry(id, openedAt, {
				kind: 'conversation',
				messageId: 'm1',
				href: '/dashboard/postbox/inbox/m1',
			});
		const list = pushObjectRecent([conversation('m1', 1)], conversation('t1', 2));
		expect(list.map((e) => e.id)).toEqual(['t1']);
	});

	it(`keeps the ${MAX_OBJECT_RECENTS} newest`, () => {
		let list: PaletteObjectRecent[] = [];
		for (let i = 0; i < 14; i += 1) list = pushObjectRecent(list, entry(`c${i}`, i));
		expect(list).toHaveLength(MAX_OBJECT_RECENTS);
		expect(list[0]?.id).toBe('c13');
		expect(list.at(-1)?.id).toBe('c4');
	});

	it('refuses an entry that does not lead into the app', () => {
		const list = pushObjectRecent(
			[entry('a', 1)],
			entry('b', 2, { href: 'https://example.com/x' })
		);
		expect(list.map((e) => e.id)).toEqual(['a']);
	});
});

describe('parseObjectRecents', () => {
	it('round-trips what it stored', () => {
		const list = [
			entry('a', 5),
			entry('t1', 4, {
				kind: 'conversation',
				href: '/dashboard/postbox/inbox/m1',
				messageId: 'm1',
				mailboxId: 'mb1',
			}),
		];
		expect(parseObjectRecents(JSON.stringify(list))).toEqual(list);
	});

	it('reads nothing, garbage and hand-edits as what still makes sense', () => {
		expect(parseObjectRecents(null)).toEqual([]);
		expect(parseObjectRecents('{not json')).toEqual([]);
		expect(parseObjectRecents('{"a":1}')).toEqual([]);
		const mixed = JSON.stringify([
			entry('ok', 2),
			{ kind: 'spaceship', id: 'x', title: 'x', href: '/dashboard/x', openedAt: 1 },
			{ kind: 'contact', id: '', title: 'x', href: '/dashboard/x', openedAt: 1 },
			{ kind: 'contact', id: 'k', title: 'x', href: 'javascript:alert(1)', openedAt: 1 },
			{ kind: 'contact', id: 'k', title: 'x', href: '/dashboard/x', openedAt: 'yesterday' },
			entry('older', 1),
		]);
		expect(parseObjectRecents(mixed).map((e) => e.id)).toEqual(['ok', 'older']);
	});

	it('sorts by when each record was opened and drops duplicates', () => {
		const raw = JSON.stringify([entry('a', 1), entry('b', 3), entry('a', 2)]);
		expect(parseObjectRecents(raw).map((e) => [e.id, e.openedAt])).toEqual([
			['b', 3],
			['a', 2],
		]);
	});
});

describe('objectRecentsStorageKey', () => {
	it('separates people and organizations', () => {
		const keys = new Set([
			objectRecentsStorageKey('u1', 'o1'),
			objectRecentsStorageKey('u2', 'o1'),
			objectRecentsStorageKey('u1', 'o2'),
			objectRecentsStorageKey('u1', null),
		]);
		expect(keys.size).toBe(4);
	});
});

describe('jumpBackEntries', () => {
	it('leaves out the records on screen, so the first row is the one before this', () => {
		const list = [entry('now', 3), entry('before', 2), entry('earlier', 1)];
		expect(jumpBackEntries(list, new Set(['campaign:now'])).map((e) => e.id)).toEqual([
			'before',
			'earlier',
		]);
		expect(jumpBackEntries(list, new Set()).map((e) => e.id)).toEqual(['now', 'before', 'earlier']);
	});
});

describe('objectRecencyIndex', () => {
	it('knows each record, and a conversation by the message its route opens too', () => {
		const index = objectRecencyIndex([
			entry('t1', 9, {
				kind: 'conversation',
				messageId: 'm1',
				href: '/dashboard/postbox/inbox/m1',
			}),
			entry('c1', 4),
		]);
		expect(index.get('t1')).toBe(9);
		expect(index.get('m1')).toBe(9);
		expect(index.get('c1')).toBe(4);
		expect(index.get('unknown')).toBeUndefined();
	});
});
