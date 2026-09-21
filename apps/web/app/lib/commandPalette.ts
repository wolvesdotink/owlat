/**
 * Shared command-palette model + pure helpers for the app-wide `AppCommandPalette`.
 *
 * The palette is assembled from an ordered set of *providers* (see
 * `~/lib/commandPaletteRegistry`), each of which contributes one or more grouped
 * `PaletteGroup`s:
 *   1. current-surface actions (e.g. Postbox reader actions + folders) — only
 *      while that surface is mounted and on its route;
 *   2. navigation — every sidebar destination;
 *   3. object search — contacts / templates / campaigns (existing search index);
 *   4. verbs — New campaign, Compose, New contact…
 *
 * Three cross-cutting behaviours also live here, all pure:
 *   - FUZZY matching — items are scored by subsequence, not substring, so
 *     "pbx settings" finds "Postbox settings", and the matched character
 *     positions come back so the row can highlight them;
 *   - MODE PREFIXES — `>` commands, `@` people, `#` labels/folders narrow the
 *     palette to the groups that opted into that mode;
 *   - ARGUMENT items — an item can ask for an argument instead of running, so
 *     "Label as…" stays one row rather than one row per label.
 *
 * These merge/order/cap/score helpers live here as pure functions so they can be
 * unit-tested without mounting the component (see __tests__/commandPalette.test.ts);
 * the provider gating/dedup rules live alongside in `commandPaletteRegistry.ts`.
 */

/**
 * One choice in an item's two-step ARGUMENT flow (see
 * {@link PaletteArgumentSpec}). Deliberately not a `PaletteItem`: an option is
 * only ever reachable from its parent item, so it needs no icon, hint, or
 * keep-open semantics of its own.
 */
export interface PaletteArgumentOption {
	id: string;
	label: string;
	subtitle?: string;
	run: () => void;
}

/**
 * Turns one item into a two-step flow: selecting the item does not run it, it
 * asks for an argument and then runs the chosen option.
 *
 * This is what keeps "Label as…" ONE row instead of one row per label — the
 * palette's flat item list has no room for a mailbox's thirty labels, and
 * flooding it with them buries every other command.
 *
 * `promptKey` and `headingKey` are i18n message keys: providers are pure
 * module-scope registries and cannot call `useI18n`, exactly like group
 * headings.
 */
export interface PaletteArgumentSpec {
	/** Message key for the chip shown in place of the query prefix. */
	promptKey: string;
	/** Message key for the heading above the option list. */
	headingKey: string;
	/** Icon for every option row (options are homogeneous by construction). */
	icon: string;
	options: PaletteArgumentOption[];
}

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
	/**
	 * When present, selecting this item opens its argument step instead of
	 * running it; `run` is then never called (the chosen option's `run` is).
	 */
	argument?: PaletteArgumentSpec;
}

/**
 * Which typed PREFIX a group belongs to. `all` (the default) is the unprefixed
 * palette, where every group shows.
 *
 * `ask` is the odd one out: no group declares it, because the knowledge answer
 * is not a list of objects. It exists so a typed `?` reaches the shell as a
 * mode like any other rather than as a special case parsed twice.
 */
export type PaletteMode = 'all' | 'commands' | 'people' | 'labels' | 'ask';

/** The prefix characters that narrow the palette to one kind of result. */
const PALETTE_MODE_PREFIXES: Readonly<Record<string, PaletteMode>> = {
	'>': 'commands',
	'@': 'people',
	'#': 'labels',
	'?': 'ask',
};

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
	/**
	 * Which prefix mode this group answers to. A group without one appears only
	 * in the unprefixed palette — a provider has to opt IN to `>`/`@`/`#`, so a
	 * new group can never silently pollute a narrowed search.
	 */
	mode?: PaletteMode;
	items: PaletteItem[];
}

/** A query split into its mode prefix and the term the user actually typed. */
export interface ParsedPaletteQuery {
	mode: PaletteMode;
	/** The query with the prefix removed — what providers filter on. */
	term: string;
	/** The prefix character, or '' when there is none. */
	prefix: string;
}

/**
 * Split a raw palette query into its mode prefix and term. `> arch` narrows to
 * commands, `@ada` to people, `#work` to labels/folders; anything else is the
 * unprefixed palette. Pure.
 */
export function parsePaletteQuery(raw: string): ParsedPaletteQuery {
	const trimmed = raw.trimStart();
	const prefix = trimmed.slice(0, 1);
	const mode = PALETTE_MODE_PREFIXES[prefix];
	if (!mode) return { mode: 'all', term: raw, prefix: '' };
	return { mode, term: trimmed.slice(1).trimStart(), prefix };
}

/**
 * Keep only the groups a mode admits. `all` admits everything; a narrowed mode
 * admits exactly the groups that declared it. Pure.
 */
export function groupsForMode(groups: PaletteGroup[], mode: PaletteMode): PaletteGroup[] {
	if (mode === 'all') return groups.slice();
	return groups.filter((group) => group.mode === mode);
}

/**
 * Build the option list of an item's argument step as a single palette group,
 * filtered by the query with the same fuzzy scorer as everything else. Pure.
 */
export function buildArgumentGroups(spec: PaletteArgumentSpec, query: string): PaletteGroup[] {
	return [
		{
			key: 'argument',
			heading: spec.headingKey,
			order: 0,
			cap: Number.MAX_SAFE_INTEGER,
			items: filterItems(
				spec.options.map((option) => ({
					id: `argument:${option.id}`,
					label: option.label,
					subtitle: option.subtitle,
					icon: spec.icon,
					run: option.run,
				})),
				query
			),
		},
	];
}

/** Default max items rendered per group before truncation. */
const DEFAULT_GROUP_CAP = 6;

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

/** A query's match against one string: how good, and which characters matched. */
export interface FuzzyMatch {
	score: number;
	/** Indices into the ORIGINAL (un-lowercased) text, ascending. */
	indices: number[];
}

/** Scoring constants. Contiguous matches always outrank scattered ones. */
const CONTIGUOUS_BASE = 1000;
const PREFIX_BONUS = 500;
const WORD_START_BONUS = 250;
const SUBSEQUENCE_BASE = 400;
const GAP_PENALTY = 4;
const SUBSEQUENCE_WORD_BONUS = 20;

/** A position that starts a word — the character before it is a separator. */
function isWordStart(text: string, index: number): boolean {
	if (index === 0) return true;
	return /[\s\-_/.:@]/.test(text[index - 1] ?? '');
}

/**
 * Score `query` against `text` as a SUBSEQUENCE: every query character has to
 * appear, in order, but not adjacently — so "pbx settings" finds "Postbox
 * settings", which plain substring filtering never could.
 *
 * A contiguous hit is always worth more than a scattered one, a hit at the
 * start of the text more than one in the middle, and a hit that lands on word
 * starts more than one that lands mid-word. Returns null when the text does not
 * contain the query at all. An empty query matches everything with score 0.
 * Pure.
 */
export function fuzzyMatch(text: string, query: string): FuzzyMatch | null {
	const needle = query.trim().toLowerCase();
	if (!needle) return { score: 0, indices: [] };
	const haystack = text.toLowerCase();

	const direct = haystack.indexOf(needle);
	if (direct >= 0) {
		const bonus =
			direct === 0 ? PREFIX_BONUS : isWordStart(haystack, direct) ? WORD_START_BONUS : 0;
		return {
			score: CONTIGUOUS_BASE + bonus - direct,
			indices: Array.from({ length: needle.length }, (_, offset) => direct + offset),
		};
	}

	const indices: number[] = [];
	let cursor = 0;
	for (const char of needle) {
		const found = haystack.indexOf(char, cursor);
		if (found === -1) return null;
		indices.push(found);
		cursor = found + 1;
	}

	let gaps = 0;
	let wordStarts = 0;
	indices.forEach((index, position) => {
		if (position > 0 && index !== (indices[position - 1] ?? -1) + 1) gaps += 1;
		if (isWordStart(haystack, index)) wordStarts += 1;
	});
	return {
		score:
			SUBSEQUENCE_BASE -
			(indices[0] ?? 0) -
			gaps * GAP_PENALTY +
			wordStarts * SUBSEQUENCE_WORD_BONUS,
		indices,
	};
}

/** One item that survived filtering, with the match that got it there. */
export interface ScoredPaletteItem<T> {
	item: T;
	/** Which field matched — the label always wins over the subtitle. */
	field: 'label' | 'subtitle';
	score: number;
	indices: number[];
}

/**
 * Fuzzy-filter and rank items by a query over `label` + `subtitle`.
 *
 * Label matches always outrank subtitle matches (a subtitle is context, not a
 * name); within a field, {@link fuzzyMatch} decides; ties keep input order, so
 * a provider's own ordering survives. An empty query returns the input
 * unchanged. Pure.
 */
export function scoreItems<T extends { label: string; subtitle?: string }>(
	items: T[],
	rawQuery: string
): ScoredPaletteItem<T>[] {
	const query = rawQuery.trim();
	if (!query) {
		return items.map((item) => ({ item, field: 'label' as const, score: 0, indices: [] }));
	}

	const scored: Array<ScoredPaletteItem<T> & { rank: number; index: number }> = [];
	items.forEach((item, index) => {
		const onLabel = fuzzyMatch(item.label, query);
		if (onLabel) {
			scored.push({ item, field: 'label', rank: 0, ...onLabel, index });
			return;
		}
		const onSubtitle = item.subtitle ? fuzzyMatch(item.subtitle, query) : null;
		if (onSubtitle) scored.push({ item, field: 'subtitle', rank: 1, ...onSubtitle, index });
	});

	return scored
		.sort((a, b) => a.rank - b.rank || b.score - a.score || a.index - b.index)
		.map(({ item, field, score, indices }) => ({ item, field, score, indices }));
}

/**
 * Fuzzy-filter items by a query over `label` + `subtitle`, keeping only the
 * items (see {@link scoreItems} for the ranking rules). Pure.
 */
export function filterItems<T extends { label: string; subtitle?: string }>(
	items: T[],
	rawQuery: string
): T[] {
	return scoreItems(items, rawQuery).map((entry) => entry.item);
}

/** A run of text, flagged as matched or not, for rendering highlights. */
export interface HighlightSegment {
	text: string;
	isMatch: boolean;
}

/**
 * Split `text` into matched/unmatched runs for the given query, so the palette
 * can bold exactly the characters the fuzzy scorer matched on. Text that does
 * not match at all comes back as a single unmatched run, which makes this safe
 * to call for every rendered row. Pure.
 */
export function highlightSegments(text: string, rawQuery: string): HighlightSegment[] {
	const match = fuzzyMatch(text, rawQuery);
	if (!match || match.indices.length === 0) return [{ text, isMatch: false }];
	const matched = new Set(match.indices);
	const segments: HighlightSegment[] = [];
	// Code units, not code points: the indices come from `indexOf`, so the two
	// have to agree. Adjacent unmatched units merge back into one run anyway.
	for (const [index, char] of text.split('').entries()) {
		const isMatch = matched.has(index);
		const last = segments[segments.length - 1];
		if (last && last.isMatch === isMatch) last.text += char;
		else segments.push({ text: char, isMatch });
	}
	return segments;
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
