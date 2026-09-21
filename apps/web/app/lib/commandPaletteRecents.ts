/**
 * The palette's recent-search memory, scope-tagged.
 *
 * There used to be two stores: the palette's flat `owlat_recent_searches` list
 * of object-search terms, and the Postbox search bar's private
 * `owlat_postbox_recent_searches`. With one overlay serving every corpus, two
 * histories would surface a `from:ines has:attachment` under a knowledge
 * question, so the two fold into one map keyed by {@link PaletteScope} and the
 * overlay only ever offers the history of the scope you are in.
 *
 * Both older shapes are read on load: a flat array is the pre-scope palette
 * history and lands in `everything`, and the search bar's key is absorbed into
 * `mail` and then removed. Saved searches are untouched — they live in Convex
 * and are a different thing (named, synced, pinnable).
 *
 * Pure: the storage IO lives in `~/composables/useCommandPaletteRecents`, which
 * is what makes the migration testable without a browser.
 */
import type { PaletteScope } from './commandPaletteScope';

/** The palette's storage key, unchanged — the value under it grew a shape. */
export const PALETTE_RECENTS_KEY = 'owlat_recent_searches';

/** The Postbox search bar's retired private key, drained on first load. */
export const LEGACY_MAIL_RECENTS_KEY = 'owlat_postbox_recent_searches';

/** How many terms are kept per scope (the search bar's old depth). */
export const MAX_RECENTS_PER_SCOPE = 8;

/** Recent query terms per scope, newest first. */
export type ScopedRecents = Record<PaletteScope, string[]>;

export function emptyScopedRecents(): ScopedRecents {
	return { mail: [], ask: [], everything: [] };
}

/** Non-empty strings only, newest-first, deduplicated and capped. */
function normalize(values: unknown): string[] {
	if (!Array.isArray(values)) return [];
	const seen = new Set<string>();
	const kept: string[] = [];
	for (const value of values) {
		if (typeof value !== 'string') continue;
		const trimmed = value.trim();
		if (!trimmed || seen.has(trimmed)) continue;
		seen.add(trimmed);
		kept.push(trimmed);
		if (kept.length >= MAX_RECENTS_PER_SCOPE) break;
	}
	return kept;
}

/**
 * Read the palette's stored history. Accepts the scope-tagged object and the
 * pre-scope flat array (which was object search, i.e. `everything`); anything
 * else — absent, truncated, hand-edited — reads as empty rather than throwing.
 * Pure.
 */
export function parseScopedRecents(raw: string | null): ScopedRecents {
	const recents = emptyScopedRecents();
	if (!raw) return recents;
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return recents;
	}
	if (Array.isArray(parsed)) {
		recents.everything = normalize(parsed);
		return recents;
	}
	if (!parsed || typeof parsed !== 'object') return recents;
	const record = parsed as Record<string, unknown>;
	for (const scope of Object.keys(recents) as PaletteScope[]) {
		recents[scope] = normalize(record[scope]);
	}
	return recents;
}

/**
 * Fold the search bar's private history into the Mail scope. The palette's own
 * entries stay in front — they are the newer store — and the cap does the rest.
 * Pure.
 */
export function absorbLegacyMailRecents(recents: ScopedRecents, raw: string | null): ScopedRecents {
	let parsed: unknown;
	try {
		parsed = raw ? JSON.parse(raw) : null;
	} catch {
		return recents;
	}
	const legacy = normalize(parsed);
	if (legacy.length === 0) return recents;
	return { ...recents, mail: normalize([...recents.mail, ...legacy]) };
}

/** Record `term` as the newest entry of `scope`. Pure. */
export function pushScopedRecent(
	recents: ScopedRecents,
	scope: PaletteScope,
	term: string
): ScopedRecents {
	const trimmed = term.trim();
	if (!trimmed) return recents;
	return { ...recents, [scope]: normalize([trimmed, ...recents[scope]]) };
}
