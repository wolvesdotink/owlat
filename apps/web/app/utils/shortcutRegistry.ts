/**
 * ONE keyboard-shortcut registry for the whole app (idea 43b).
 *
 * Before this module the app answered keys from five unrelated places — the
 * app-wide `useKeyboardShortcuts` map, the Postbox `resolvePostboxShortcut`
 * switch, the Review Queue's own switch, the desktop workspace hotkeys and the
 * composer key handler — each with its own idea of what a "shortcut" is and its
 * own hand-maintained cheat sheet. Nothing could tell you whether two surfaces
 * claimed the same key, and the app-wide sheet had drifted away from the map it
 * claimed to document.
 *
 * This file is the pure half: chords, scoping, binding resolution (defaults →
 * preset → the user's own remaps), conflict detection and cheat-sheet
 * generation. The vocabulary itself lives in `shortcutCatalog.ts`; the mutable
 * "which bindings are live right now" state lives in `shortcutScope.ts`.
 *
 * ## Chords
 *
 * A chord is one or more STEPS separated by spaces (`'g i'` — press g, then i).
 * A step is zero or more modifiers joined to a key with `+`:
 *
 *   `e`            a bare key
 *   `U`            Shift+U — a printable key already encodes Shift in its case,
 *                  so it is written as the character the keyboard produces
 *   `mod+Enter`    Cmd on macOS, Ctrl everywhere else
 *   `alt+shift+ArrowUp`
 *
 * Keys are DOM `KeyboardEvent.key` values verbatim (case-sensitive), so a chord
 * built from an event compares by string equality with a catalog entry — there
 * is no per-surface parsing to get subtly wrong.
 */

export type ShortcutScope = 'global' | 'postbox' | 'review' | 'composer' | 'workspace';

export interface ShortcutDefinition {
	/** Stable id, `scope.verb` (e.g. `postbox.archive`). Never shown to a user. */
	id: string;
	scope: ShortcutScope;
	/** Default chords, most canonical first. Empty means "documented, unbound". */
	keys: readonly string[];
	/** i18n key for the human description. */
	labelKey: string;
	/** i18n key for the cheat-sheet group heading. */
	groupKey: string;
	/**
	 * Chord-shaped display override for entries a sheet should summarize rather
	 * than enumerate: `'1–9'` reads better than nine rows, and `'mod+shift+F'`
	 * is what the user presses even though the browser reports `mod+F`. Still
	 * run through `formatChord`, so ⌘/Ctrl stays platform-correct.
	 */
	displayKeys?: string;
	/**
	 * False for chords the user may not move: platform conventions (Esc,
	 * Cmd+Enter) and keys whose handler is not routed through the registry.
	 */
	remappable?: boolean;
}

/** Modifiers, in the canonical order a normalized step writes them. */
const MODIFIER_ORDER = ['mod', 'alt', 'shift'] as const;
type Modifier = (typeof MODIFIER_ORDER)[number];

/** Aliases people (and older call sites) write for the platform modifier. */
const MODIFIER_ALIASES: Record<string, Modifier> = {
	mod: 'mod',
	cmd: 'mod',
	meta: 'mod',
	ctrl: 'mod',
	control: 'mod',
	alt: 'alt',
	option: 'alt',
	shift: 'shift',
};

/**
 * Normalize one step: canonical modifier spelling and order, key verbatim.
 * Returns null for a malformed step (empty key, unknown modifier) so callers
 * can reject a bad remap instead of storing a chord nothing will ever match.
 */
function normalizeStep(step: string): string | null {
	if (step.length === 0) return null;
	// A lone '+' IS a key ('+' on the numpad row), not an empty modifier list.
	if (step === '+') return '+';
	const parts = step.split('+');
	const key = parts.pop();
	if (!key) return null;
	const mods = new Set<Modifier>();
	for (const raw of parts) {
		const mod = MODIFIER_ALIASES[raw.toLowerCase()];
		if (!mod) return null;
		mods.add(mod);
	}
	return [...MODIFIER_ORDER.filter((m) => mods.has(m)), key].join('+');
}

/** The steps of a chord, already normalized. Empty for a malformed chord. */
export function chordSteps(chord: string): string[] {
	// The space bar is written 'Space', because ' ' is the sequence separator.
	// Callers hand us raw `event.key` values, so accept the literal too.
	const raw = (chord === ' ' ? 'Space' : chord).split(' ').filter((s) => s.length > 0);
	if (raw.length === 0) return [];
	const steps: string[] = [];
	for (const step of raw) {
		const normalized = normalizeStep(step);
		if (!normalized) return [];
		steps.push(normalized);
	}
	return steps;
}

/** Canonical spelling of a chord, or `null` when it cannot be parsed. */
export function normalizeChord(chord: string): string | null {
	const steps = chordSteps(chord);
	return steps.length === 0 ? null : steps.join(' ');
}

export interface ChordEventLike {
	key: string;
	metaKey?: boolean;
	ctrlKey?: boolean;
	altKey?: boolean;
	shiftKey?: boolean;
}

/**
 * The chord step a keyboard event produces.
 *
 * Cmd and Ctrl both normalize to `mod`: the same binding has to fire on both
 * platforms, and no shortcut in the catalog needs to tell them apart. Shift is
 * only named for keys that are not a single printable character — for those the
 * character itself already carries it (`Shift+u` arrives as `'U'`), and naming
 * it too would make `U` and `shift+U` two different chords for one keypress.
 */
export function chordFromEvent(event: ChordEventLike): string {
	const mods: Modifier[] = [];
	if (event.metaKey || event.ctrlKey) mods.push('mod');
	if (event.altKey) mods.push('alt');
	if (event.shiftKey && event.key.length > 1) mods.push('shift');
	const key = event.key === ' ' ? 'Space' : event.key;
	return [...MODIFIER_ORDER.filter((m) => mods.includes(m)), key].join('+');
}

/** Display glyphs for keys whose `KeyboardEvent.key` name is not what to print. */
const KEY_GLYPHS: Record<string, string> = {
	ArrowUp: '↑',
	ArrowDown: '↓',
	ArrowLeft: '←',
	ArrowRight: '→',
	Escape: 'Esc',
	Delete: 'Del',
	Backspace: '⌫',
};

/**
 * Render a chord as the sequence of `<kbd>` tokens a cheat sheet shows.
 * `mod` becomes ⌘ on macOS and Ctrl elsewhere, which is the whole reason the
 * catalog stores the platform-neutral name.
 */
export function formatChord(chord: string, isMac: boolean): string[] {
	const tokens: string[] = [];
	for (const step of chordSteps(chord)) {
		const parts = step === '+' ? ['+'] : step.split('+');
		const key = parts.pop() as string;
		for (const mod of parts) {
			if (mod === 'mod') tokens.push(isMac ? '⌘' : 'Ctrl');
			else if (mod === 'alt') tokens.push(isMac ? '⌥' : 'Alt');
			else tokens.push('Shift');
		}
		tokens.push(KEY_GLYPHS[key] ?? key);
	}
	return tokens;
}

/** Two definitions in one scope claiming the same chord. */
export interface ShortcutConflict {
	scope: ShortcutScope;
	chord: string;
	/** The winning id first, then everyone it shadowed. */
	ids: string[];
}

export interface ShortcutBindings {
	/** id → its chords, in display order. */
	byId: ReadonlyMap<string, readonly string[]>;
	/** scope → chord → id. Only the winner of a conflict is listed. */
	byScope: ReadonlyMap<ShortcutScope, ReadonlyMap<string, string>>;
	/** Non-empty when a preset or a user remap collides inside one scope. */
	conflicts: readonly ShortcutConflict[];
}

/** A partial rebinding of catalog ids: preset overlays and user remaps alike. */
export type ShortcutOverlay = Readonly<Record<string, readonly string[]>>;

/**
 * Resolve defaults + overlays into the live binding tables.
 *
 * Overlays are applied in order and REPLACE a definition's chords outright
 * (rather than adding to them), which is what makes a preset able to free a key
 * as well as claim one — binding an id to `[]` documents it as unbound.
 *
 * Conflicts do not throw: a shortcut the user broke must still leave the rest of
 * the keyboard working. First writer wins and the collision is reported, so the
 * remapping UI can refuse the change and a unit test can hold the shipped
 * catalog and presets to zero.
 */
export function buildShortcutBindings(
	definitions: readonly ShortcutDefinition[],
	overlays: readonly ShortcutOverlay[] = []
): ShortcutBindings {
	const byId = new Map<string, readonly string[]>();
	const byScope = new Map<ShortcutScope, Map<string, string>>();
	const conflicts: ShortcutConflict[] = [];

	for (const def of definitions) {
		let keys = def.keys;
		for (const overlay of overlays) {
			const replacement = overlay[def.id];
			if (replacement) keys = replacement;
		}
		const chords: string[] = [];
		for (const key of keys) {
			const chord = normalizeChord(key);
			if (chord && !chords.includes(chord)) chords.push(chord);
		}
		byId.set(def.id, chords);

		let scoped = byScope.get(def.scope);
		if (!scoped) byScope.set(def.scope, (scoped = new Map()));
		for (const chord of chords) {
			const owner = scoped.get(chord);
			if (owner === undefined) {
				scoped.set(chord, def.id);
				continue;
			}
			if (owner === def.id) continue;
			const existing = conflicts.find((c) => c.scope === def.scope && c.chord === chord);
			if (existing) existing.ids.push(def.id);
			else conflicts.push({ scope: def.scope, chord, ids: [owner, def.id] });
		}
	}

	return { byId, byScope, conflicts };
}

/**
 * Which definition owns `chord`, searching the scope chain innermost-first.
 *
 * This is the shadowing rule the old five systems could not express: while the
 * Postbox is on screen `g s` means "go to Starred", and the moment it unmounts
 * the same chord goes back to the global "go to Admin".
 */
export function resolveShortcutId(
	bindings: ShortcutBindings,
	chord: string,
	scopes: readonly ShortcutScope[]
): string | null {
	const normalized = normalizeChord(chord);
	if (!normalized) return null;
	for (const scope of scopes) {
		const id = bindings.byScope.get(scope)?.get(normalized);
		if (id) return id;
	}
	return null;
}

/**
 * True when `step` starts a longer chord in one of the active scopes — the
 * signal the dispatcher needs to hold `g` instead of discarding it. Generic
 * over the catalog, so a new `g`-chord (or a future two-key sequence on another
 * prefix) needs no dispatcher change.
 */
export function isChordPrefix(
	bindings: ShortcutBindings,
	step: string,
	scopes: readonly ShortcutScope[]
): boolean {
	const normalized = normalizeChord(step);
	if (!normalized) return false;
	const prefix = `${normalized} `;
	for (const scope of scopes) {
		for (const chord of bindings.byScope.get(scope)?.keys() ?? []) {
			if (chord.startsWith(prefix)) return true;
		}
	}
	return false;
}

export interface ShortcutSheetItem {
	id: string;
	labelKey: string;
	/** Ready-to-render `<kbd>` tokens for the first (canonical) binding. */
	keys: string[];
	/** Every binding, formatted — a preset can leave an id with two chords. */
	alternates: string[][];
}

export interface ShortcutSheetGroup {
	groupKey: string;
	items: ShortcutSheetItem[];
}

/**
 * The `<kbd>` run a sheet row prints: the canonical chord plus ONE alternate,
 * flattened — `j ↓`, `# Del`. Beyond two the row stops reading as a hint and
 * starts reading as a table, so the rest live in `alternates` for anyone who
 * wants them.
 */
export function shortcutSheetKeys(item: ShortcutSheetItem): string[] {
	return item.alternates.slice(0, 2).flat();
}

/**
 * Build a cheat sheet from the catalog — the ONLY way either sheet is allowed to
 * learn what the keyboard does. Groups keep catalog order (which is authored
 * most-used-first), unbound ids are dropped, and shadowed globals are omitted
 * from a scoped sheet so it never promises a key the surface has taken over.
 */
export function buildShortcutSheet(
	definitions: readonly ShortcutDefinition[],
	bindings: ShortcutBindings,
	opts: { scopes: readonly ShortcutScope[]; isMac?: boolean }
): ShortcutSheetGroup[] {
	const isMac = opts.isMac === true;
	const groups: ShortcutSheetGroup[] = [];
	const byGroup = new Map<string, ShortcutSheetGroup>();

	for (const def of definitions) {
		if (!opts.scopes.includes(def.scope)) continue;
		const chords = bindings.byId.get(def.id) ?? [];
		// Documented but unbound (a preset freed it) — nothing to promise.
		if (chords.length === 0) continue;
		// A nearer scope owns this chord, so the outer one is unreachable here.
		const visible = chords.filter(
			(chord) => resolveShortcutId(bindings, chord, opts.scopes) === def.id
		);
		if (visible.length === 0) continue;
		const display = def.displayKeys ? [def.displayKeys] : visible;

		let group = byGroup.get(def.groupKey);
		if (!group) {
			group = { groupKey: def.groupKey, items: [] };
			byGroup.set(def.groupKey, group);
			groups.push(group);
		}
		group.items.push({
			id: def.id,
			labelKey: def.labelKey,
			keys: formatChord(display[0] as string, isMac),
			alternates: display.map((chord) => formatChord(chord, isMac)),
		});
	}

	return groups;
}
