/**
 * THE ROUTE → SCOPE TABLE.
 *
 * The overlay decides which corpus it searches from the route it was opened on.
 * Getting that wrong is not a crash — ⌘K on the mailbox would quietly search
 * contacts instead of mail, and nobody files a bug for "search felt worse". So
 * the mapping is pinned here, including the two ways it is easy to break: a
 * sibling route that merely shares a textual prefix, and a new route group that
 * silently inherits somebody else's scope.
 */
import { describe, expect, it } from 'vitest';
import type { PaletteGroup } from '../commandPalette';
import {
	MAIL_SCOPE_GROUP_KEYS,
	PALETTE_SCOPE_CYCLE,
	PALETTE_SCOPE_LABEL_KEYS,
	type PaletteScope,
	defaultScopeForRoute,
	groupsForScope,
	nextPaletteScope,
} from '../commandPaletteScope';

function group(key: string): PaletteGroup {
	return {
		key,
		heading: key,
		order: 0,
		items: [{ id: key, label: key, icon: 'x', run: () => {} }],
	};
}

describe('defaultScopeForRoute', () => {
	it.each([
		['/dashboard/postbox', 'mail'],
		['/dashboard/postbox/inbox', 'mail'],
		['/dashboard/postbox/inbox/message1', 'mail'],
		['/dashboard/postbox/search', 'mail'],
		['/dashboard/knowledge', 'ask'],
		['/dashboard/knowledge/entry1', 'ask'],
		['/dashboard/files', 'ask'],
		['/dashboard/files/file1', 'ask'],
		['/dashboard', 'everything'],
		['/dashboard/campaigns', 'everything'],
		['/dashboard/audience/contacts', 'everything'],
	] as const)('opens %s on the %s scope', (path, scope) => {
		expect(defaultScopeForRoute(path)).toBe(scope);
	});

	it('does not treat a sibling that shares a textual prefix as the surface', () => {
		// The registry's matcher is segment-aware; a plain `startsWith` would put
		// these on Mail and on Ask respectively.
		expect(defaultScopeForRoute('/dashboard/postbox-archive')).toBe('everything');
		expect(defaultScopeForRoute('/dashboard/knowledgebase')).toBe('everything');
	});

	it('keeps the Team Inbox on Everything — its threads join it, they are not a scope', () => {
		// Team Inbox threads ARE searchable now (`inbox.queries.listThreads` grew a
		// `search` argument), but they arrive as a route-scoped PROVIDER inside the
		// Everything palette — `core:inbox-threads`, gated on `matchRoute` — rather
		// than as a fourth chip on the Tab cycle. A scope narrows the overlay to one
		// corpus; in the Team Inbox you still want the contacts and the commands.
		expect(defaultScopeForRoute('/dashboard/inbox')).toBe('everything');
		expect(defaultScopeForRoute('/dashboard/inbox/thread1')).toBe('everything');
	});

	it('names every scope it can return', () => {
		for (const scope of PALETTE_SCOPE_CYCLE) {
			expect(PALETTE_SCOPE_LABEL_KEYS[scope]).toMatch(/^shared\.commandPaletteScope\./);
		}
	});
});

describe('nextPaletteScope', () => {
	it('cycles through every scope and back', () => {
		const visited: PaletteScope[] = [];
		let scope: PaletteScope = PALETTE_SCOPE_CYCLE[0]!;
		for (let step = 0; step < PALETTE_SCOPE_CYCLE.length; step += 1) {
			visited.push(scope);
			scope = nextPaletteScope(scope);
		}
		expect(visited).toEqual([...PALETTE_SCOPE_CYCLE]);
		expect(scope).toBe(PALETTE_SCOPE_CYCLE[0]);
	});

	it('skips a scope the instance switched off', () => {
		const available = (candidate: PaletteScope) => candidate !== 'ask';
		expect(nextPaletteScope('mail', available)).toBe('everything');
		expect(nextPaletteScope('everything', available)).toBe('mail');
	});

	it('is never a dead key when only one scope is left', () => {
		expect(nextPaletteScope('mail', (candidate) => candidate === 'mail')).toBe('mail');
	});
});

describe('groupsForScope', () => {
	const groups = [group('recent'), group('mail-hits'), group('navigation'), group('contacts')];

	it('narrows the unprefixed Mail palette to the mail groups', () => {
		expect(groupsForScope(groups, 'mail', 'all').map((g) => g.key)).toEqual([
			'recent',
			'mail-hits',
		]);
		for (const key of MAIL_SCOPE_GROUP_KEYS) expect(typeof key).toBe('string');
	});

	it('stops narrowing the moment a prefix asks for something else', () => {
		// `>` means the user asked for commands; Mail scope must not eat them.
		expect(groupsForScope(groups, 'mail', 'commands').map((g) => g.key)).toEqual(
			groups.map((g) => g.key)
		);
	});

	it('leaves the other scopes alone', () => {
		expect(groupsForScope(groups, 'everything', 'all')).toHaveLength(groups.length);
		expect(groupsForScope(groups, 'ask', 'all')).toHaveLength(groups.length);
	});
});
