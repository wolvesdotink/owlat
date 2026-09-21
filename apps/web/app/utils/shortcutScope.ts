/**
 * The live state of the shortcut registry: which scopes own the keyboard right
 * now, and which bindings are in force for this user.
 *
 * Module scope rather than a composable, for the same reason
 * `helpOverlayOwnership.ts` is: the readers are keydown handlers that run long
 * after any render, from components that do not know about each other. The
 * bindings are a `shallowRef` so the two cheat sheets re-render when the user
 * switches preset — a `ref` around a Map of Maps would deep-track for nothing.
 *
 * Scopes form a STACK, not a set. `postbox` pushed on top of `global` means a
 * chord is looked up in `postbox` first and only falls through to `global` when
 * the mailbox has not claimed it — which is how `g s` can be "go to Starred" in
 * the Postbox and "go to Admin" everywhere else without either surface knowing
 * the other exists.
 */

import { shallowRef, computed } from 'vue';
import type { ShortcutBindings, ShortcutScope, ChordEventLike } from './shortcutRegistry';
import {
	buildShortcutBindings,
	chordFromEvent,
	isChordPrefix,
	resolveShortcutId,
} from './shortcutRegistry';
import { SHORTCUT_CATALOG } from './shortcutCatalog';
import type { ShortcutPreset, StoredShortcutOverride } from './shortcutPresets';
import {
	SHORTCUT_PRESETS,
	SHORTCUT_PRESET_DEFAULT,
	shortcutOverridesToOverlay,
} from './shortcutPresets';

/**
 * A push counter per scope, not a plain array: two surfaces in the same scope
 * can overlap for a tick during a route change, and the first unmount must not
 * hand the scope back while the second still holds it.
 */
const depth = new Map<ShortcutScope, number>();
/** Push order, so the innermost claim is searched first. */
let order: ShortcutScope[] = [];

/**
 * Claim the keyboard for a scope while a surface is mounted. Returns the
 * release function — idempotent, so an unmount path that runs twice cannot
 * under-count and strand the scope on the stack.
 */
export function pushShortcutScope(scope: ShortcutScope): () => void {
	depth.set(scope, (depth.get(scope) ?? 0) + 1);
	if (!order.includes(scope)) order.push(scope);
	let released = false;
	return () => {
		if (released) return;
		released = true;
		const next = (depth.get(scope) ?? 1) - 1;
		if (next > 0) {
			depth.set(scope, next);
			return;
		}
		depth.delete(scope);
		order = order.filter((s) => s !== scope);
	};
}

/**
 * The lookup chain: innermost claimed scope first, `global` always last. Every
 * surface answers its own keys before the app-wide map gets a look in, and the
 * app-wide map never disappears.
 */
export function activeShortcutScopes(): ShortcutScope[] {
	return [...[...order].reverse(), 'global'];
}

/** Test seam — drops every claim. */
export function resetShortcutScopes(): void {
	depth.clear();
	order = [];
	clearPendingChord();
}

/**
 * The half-typed sequence chord (`g` …) the app is currently holding.
 *
 * It lives HERE, next to the bindings, rather than inside the app-wide
 * dispatcher, because it is not only the dispatcher's business. Element-level
 * handlers — the thread list's triage keys — run on the way UP to the document,
 * so without a shared "a chord is in flight" signal `g` then `s` both starred
 * the focused message and navigated to Starred. One buffer, one arbiter: the
 * dispatcher completes the chord, everyone else stands down while
 * `isChordPending()` is true.
 */
let pendingChord: string | null = null;
let pendingTimer: ReturnType<typeof setTimeout> | null = null;

/** How long a half-finished sequence chord waits for its second key. */
const CHORD_WINDOW_MS = 500;

/** The step being held, or `null` when no chord is in flight. */
export function pendingChordStep(): string | null {
	return pendingChord;
}

/** True while a sequence chord is half-typed — see `pendingChordStep`. */
export function isChordPending(): boolean {
	return pendingChord !== null;
}

/** Hold `step` as the first half of a sequence chord. */
export function beginChord(step: string): void {
	clearPendingChord();
	pendingChord = step;
	pendingTimer = setTimeout(clearPendingChord, CHORD_WINDOW_MS);
}

/** Drop whatever chord is in flight (completed, timed out, or Escaped). */
export function clearPendingChord(): void {
	if (pendingTimer) {
		clearTimeout(pendingTimer);
		pendingTimer = null;
	}
	pendingChord = null;
}

const bindingsRef = shallowRef<ShortcutBindings>(buildShortcutBindings(SHORTCUT_CATALOG));

/** Reactive handle for the cheat sheets. */
export const shortcutBindings = computed(() => bindingsRef.value);

/**
 * Apply the user's preferences. Called once from `useShortcutPreferences` when
 * the settings row loads; everything else reads the result.
 */
export function applyShortcutPreferences(
	preset: ShortcutPreset,
	overrides?: readonly StoredShortcutOverride[] | null
): ShortcutBindings {
	bindingsRef.value = buildShortcutBindings(SHORTCUT_CATALOG, [
		SHORTCUT_PRESETS[preset],
		shortcutOverridesToOverlay(overrides),
	]);
	return bindingsRef.value;
}

/** Test seam — back to the shipped map. */
export function resetShortcutPreferences(): void {
	applyShortcutPreferences(SHORTCUT_PRESET_DEFAULT, []);
}

/**
 * Which shortcut a keyboard event fires under the scopes currently claimed.
 * `scopes` is overridable so a surface can resolve against its OWN scope even
 * when something else is on top (the composer, whose handler is bound to its
 * root element rather than the window).
 */
export function resolveActiveShortcut(
	event: ChordEventLike,
	scopes: readonly ShortcutScope[] = activeShortcutScopes()
): string | null {
	return resolveShortcutId(bindingsRef.value, chordFromEvent(event), scopes);
}

/** Same, for a chord that has already been assembled (a `g`-chord sequence). */
export function resolveActiveChord(
	chord: string,
	scopes: readonly ShortcutScope[] = activeShortcutScopes()
): string | null {
	return resolveShortcutId(bindingsRef.value, chord, scopes);
}

/** True when the step just pressed begins a longer chord under these scopes. */
export function isActiveChordPrefix(
	step: string,
	scopes: readonly ShortcutScope[] = activeShortcutScopes()
): boolean {
	return isChordPrefix(bindingsRef.value, step, scopes);
}
