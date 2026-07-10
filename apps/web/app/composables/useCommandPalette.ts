/**
 * Shared control surface for the app command palette (`AppCommandPalette`,
 * mounted once in the dashboard layout). Every affordance that opens search —
 * the header `GlobalSearch` button, the mobile search button, the desktop
 * titlebar pill — goes through `open()`, so the `owlat:command-palette-open`
 * event name lives in exactly one place instead of being inlined per file.
 *
 * Surfaces without a palette (e.g. /desktop/welcome) simply don't render an
 * opener: the desktop titlebar's search pill is gated on its `show-search`
 * prop, passed only by the dashboard layout that also mounts the palette.
 */
export const COMMAND_PALETTE_OPEN_EVENT = 'owlat:command-palette-open';

export interface CommandPaletteControls {
	/** Open the app command palette (no-op on the server). */
	open: () => void;
}

export function useCommandPalette(): CommandPaletteControls {
	function open(): void {
		if (import.meta.client) window.dispatchEvent(new Event(COMMAND_PALETTE_OPEN_EVENT));
	}

	return { open };
}
