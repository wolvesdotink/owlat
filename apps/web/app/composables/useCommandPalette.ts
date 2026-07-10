import { computed, ref, type ComputedRef } from 'vue';

/**
 * Shared control surface for the app command palette (`AppCommandPalette`,
 * mounted once in the dashboard layout). Every affordance that opens search —
 * the header `GlobalSearch` button, the mobile search button, the desktop
 * titlebar pill — goes through `open()`, so the `owlat:command-palette-open`
 * event name lives in exactly one place instead of being inlined per file.
 *
 * `isMounted` is a palette-ready handshake: the palette calls `registerMounted`
 * from its own `onMounted` and disposes on unmount, so opener affordances can
 * feature-detect whether a palette is actually listening on the current surface.
 * The desktop titlebar uses it to hide its search pill on `/desktop/welcome`,
 * where no palette is mounted and a dispatched event would go nowhere.
 */
export const COMMAND_PALETTE_OPEN_EVENT = 'owlat:command-palette-open';

// Module-scoped so every caller observes the same live mount count. The palette
// only registers from a client-side `onMounted`, so this stays 0 during SSR.
const mountCount = ref(0);
const isMounted = computed(() => mountCount.value > 0);

export interface CommandPaletteControls {
	/** Reactive: is an `AppCommandPalette` currently mounted and listening? */
	isMounted: ComputedRef<boolean>;
	/** Open the app command palette (no-op on the server). */
	open: () => void;
	/** Register a mounted palette; call the returned disposer on unmount. */
	registerMounted: () => () => void;
}

export function useCommandPalette(): CommandPaletteControls {
	function open(): void {
		if (import.meta.client) window.dispatchEvent(new Event(COMMAND_PALETTE_OPEN_EVENT));
	}

	function registerMounted(): () => void {
		mountCount.value += 1;
		let disposed = false;
		return () => {
			if (disposed) return;
			disposed = true;
			mountCount.value = Math.max(0, mountCount.value - 1);
		};
	}

	return { isMounted, open, registerMounted };
}
