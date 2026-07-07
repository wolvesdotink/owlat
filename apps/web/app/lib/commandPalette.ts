/**
 * Shared command-palette model + pure helpers for the app-wide `AppCommandPalette`.
 *
 * The palette is assembled from an ordered set of *providers*, each of which
 * contributes one or more grouped `PaletteGroup`s:
 *   1. current-surface actions (e.g. Postbox reader actions + folders) — only
 *      while that surface is mounted, via `useCommandPaletteSurface`;
 *   2. navigation — every sidebar destination;
 *   3. object search — contacts / templates / campaigns (existing search index);
 *   4. verbs — New campaign, Compose, New contact…
 *
 * The merge/order/cap logic lives here as pure functions so it can be
 * unit-tested without mounting the component (see __tests__/commandPalette.test.ts).
 */

/** A single runnable palette entry. `run` fires when the user selects it. */
export interface PaletteItem {
	id: string;
	label: string;
	/** One muted line of secondary context (email, subject, "why"). */
	subtitle?: string;
	/** Optional keyboard hint chip (e.g. the Postbox single-key shortcut). */
	hint?: string;
	icon: string;
	run: () => void;
	/** When true the palette stays open after `run` (e.g. "recent" items that
	 * only refill the query rather than navigate). Defaults to close-on-run. */
	keepOpen?: boolean;
}

/** A titled, ordered bucket of items. Empty groups are dropped on merge. */
export interface PaletteGroup {
	/** Stable key for :key + de-dupe. */
	key: string;
	/** Human heading shown above the group. */
	heading: string;
	/** Lower sorts earlier. Surface actions < verbs < navigation < object search. */
	order: number;
	/** Per-group visible cap (defaults to {@link DEFAULT_GROUP_CAP}). */
	cap?: number;
	items: PaletteItem[];
}

/** Default max items rendered per group before truncation. */
export const DEFAULT_GROUP_CAP = 6;

/**
 * Merge provider groups into the final render list: drop empties, sort by
 * `order` (stable within equal order), and cap each group. Pure.
 */
export function mergeGroups(
	groups: PaletteGroup[],
	defaultCap = DEFAULT_GROUP_CAP
): PaletteGroup[] {
	return groups
		.map((group, index) => ({ group, index }))
		.filter(({ group }) => group.items.length > 0)
		.sort((a, b) => a.group.order - b.group.order || a.index - b.index)
		.map(({ group }) => ({
			...group,
			items: group.items.slice(0, group.cap ?? defaultCap),
		}));
}

/** Flatten merged groups into render order for keyboard navigation. Pure. */
export function flattenGroups(groups: PaletteGroup[]): PaletteItem[] {
	return groups.flatMap((group) => group.items);
}

/**
 * Substring-filter items by a query over `label` + `subtitle`. Prefix matches
 * on the label rank first, then label substrings, then subtitle substrings;
 * ties keep input order (stable). An empty query returns the input unchanged.
 * Pure.
 */
export function filterItems<T extends { label: string; subtitle?: string }>(
	items: T[],
	rawQuery: string
): T[] {
	const query = rawQuery.trim().toLowerCase();
	if (!query) return items.slice();

	const scored: Array<{ item: T; score: number; index: number }> = [];
	items.forEach((item, index) => {
		const label = item.label.toLowerCase();
		const subtitle = item.subtitle?.toLowerCase() ?? '';
		if (label.startsWith(query)) scored.push({ item, score: 0, index });
		else if (label.includes(query)) scored.push({ item, score: 1, index });
		else if (subtitle.includes(query)) scored.push({ item, score: 2, index });
	});

	return scored.sort((a, b) => a.score - b.score || a.index - b.index).map((entry) => entry.item);
}

/**
 * Clamp a selection index for Arrow navigation over a flat list of `length`
 * items. No wrap (matches Postbox/GlobalSearch semantics). Pure.
 */
export function moveSelection(
	current: number,
	key: 'ArrowDown' | 'ArrowUp',
	length: number
): number {
	if (length <= 0) return 0;
	if (key === 'ArrowDown') return Math.min(current + 1, length - 1);
	return Math.max(current - 1, 0);
}

/**
 * Shared registry of the *current doing-surface's* palette groups. A surface
 * (e.g. `PostboxLayout`) writes its groups on mount and clears them on unmount;
 * `AppCommandPalette` reads them reactively and merges them ahead of the global
 * navigation/verb/search providers. Groups carry `run` closures, so writes only
 * ever happen on the client (`onMounted`) — SSR keeps the empty default and
 * never tries to serialize a function. Call from component setup only.
 */
export function useCommandPaletteSurface() {
	return useState<PaletteGroup[]>('cmdk:surface-groups', () => []);
}
