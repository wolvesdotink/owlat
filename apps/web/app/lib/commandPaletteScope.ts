/**
 * The command palette's SCOPE — which corpus ⌘K searches, decided by the route.
 *
 * The app used to ship four places to type a query (the palette, the Postbox
 * rail bar, the search page, the Quick Query modal), none of which could read
 * the others' syntax. There is now one overlay, and the thing that used to be
 * "which box did you click" is this scope: on `/dashboard/postbox/**` it opens
 * on Mail with the full operator grammar, on knowledge/files it opens on Ask,
 * and everywhere else on Everything. Tab cycles, so nothing is out of reach.
 *
 * The route→scope table is the part worth pinning: a new route group that lands
 * in the wrong scope is a silently worse search, not a crash, so it gets a unit
 * test rather than a bug report (see `__tests__/commandPaletteScope.test.ts`).
 *
 * Pure — no Vue, no Convex. The reactive half lives in
 * `~/composables/useCommandPaletteScope`.
 */
import type { PaletteGroup, PaletteMode } from './commandPalette';
import { routePrefixMatcher } from './commandPaletteRegistry';

/** Which corpus the overlay searches. */
export type PaletteScope = 'mail' | 'ask' | 'everything';

/** Tab order. Mail first because it is the scope with the richest grammar. */
export const PALETTE_SCOPE_CYCLE: readonly PaletteScope[] = ['mail', 'ask', 'everything'];

/** Message keys for the scope chip. Pure module — the component translates. */
export const PALETTE_SCOPE_LABEL_KEYS: Readonly<Record<PaletteScope, string>> = {
	mail: 'shared.commandPaletteScope.scopes.mail',
	ask: 'shared.commandPaletteScope.scopes.ask',
	everything: 'shared.commandPaletteScope.scopes.everything',
};

/**
 * Route prefix → the scope the overlay opens in there, first match wins.
 *
 * `/dashboard/inbox` (Team Inbox) is deliberately absent, and stays absent now
 * that its threads are searchable: they reach the overlay as a route-scoped
 * PROVIDER inside Everything (`core:inbox-threads`, gated on `matchRoute`), not
 * as a fourth chip on the cycle. A scope NARROWS the overlay to one corpus, and
 * in the Team Inbox you still want the contacts, the settings and the commands
 * — you just also want the threads.
 */
const SCOPE_ROUTES: ReadonlyArray<{ matches: (path: string) => boolean; scope: PaletteScope }> = [
	{ matches: routePrefixMatcher('/dashboard/postbox'), scope: 'mail' },
	{ matches: routePrefixMatcher('/dashboard/knowledge'), scope: 'ask' },
	{ matches: routePrefixMatcher('/dashboard/files'), scope: 'ask' },
];

/**
 * The scope ⌘K opens in on `path`. Prefix matching is segment-aware (the
 * registry's `routePrefixMatcher`), so `/dashboard/postbox-archive` is NOT the
 * Postbox. Pure.
 */
export function defaultScopeForRoute(path: string): PaletteScope {
	for (const entry of SCOPE_ROUTES) {
		if (entry.matches(path)) return entry.scope;
	}
	return 'everything';
}

/**
 * The next scope Tab lands on, skipping any the instance has switched off (Ask
 * is gated on `ai.knowledge`). Falls back to the current scope when it is the
 * only one available, so Tab is never a dead key. Pure.
 */
export function nextPaletteScope(
	scope: PaletteScope,
	isAvailable: (candidate: PaletteScope) => boolean = () => true
): PaletteScope {
	const start = PALETTE_SCOPE_CYCLE.indexOf(scope);
	for (let step = 1; step <= PALETTE_SCOPE_CYCLE.length; step += 1) {
		const candidate = PALETTE_SCOPE_CYCLE[(start + step) % PALETTE_SCOPE_CYCLE.length]!;
		if (candidate === scope || isAvailable(candidate)) return candidate;
	}
	return scope;
}

/**
 * The groups Mail scope renders in its own (unprefixed) palette: its recents,
 * its autocomplete, its live hits, and the row that hands off to the deep search
 * page. Everything else — navigation, verbs, contacts, campaigns — stays one
 * `>`/`@`/`#` prefix or one Tab away.
 */
export const MAIL_SCOPE_GROUP_KEYS: ReadonlySet<string> = new Set([
	'recent',
	'mail-suggest',
	'mail-hits',
	'mail-search',
]);

/**
 * Keep only the groups the active scope admits.
 *
 * Only Mail narrows, and only while unprefixed: a typed `>` means the user asked
 * for commands and must get them wherever they are. Everything and Ask never
 * narrow here (Ask renders its answer instead of groups). Pure.
 */
export function groupsForScope(
	groups: PaletteGroup[],
	scope: PaletteScope,
	mode: PaletteMode
): PaletteGroup[] {
	if (scope !== 'mail' || mode !== 'all') return groups.slice();
	return groups.filter((group) => MAIL_SCOPE_GROUP_KEYS.has(group.key));
}
