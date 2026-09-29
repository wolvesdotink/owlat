import type { PaletteScope } from '~/lib/commandPaletteScope';

/**
 * Shared control surface for the app command palette (`AppCommandPalette`,
 * mounted once in the dashboard layout). Every affordance that opens search —
 * the header `GlobalSearch` button, the mobile search button, the desktop
 * titlebar pill, the Postbox `/` shortcut — goes through `open()`, so the
 * `owlat:command-palette-open` event name lives in exactly one place instead of
 * being inlined per file.
 *
 * A caller may name the SCOPE to open in (Postbox's `/` opens on Mail) and the
 * QUERY to start from. Without them the palette follows the route and opens
 * empty, which is the common case; the detail is optional so a plain `Event`
 * from an older caller still opens it.
 *
 * Surfaces without a palette (e.g. /desktop/welcome) simply don't render an
 * opener: the desktop titlebar's search pill is gated on its `show-search`
 * prop, passed only by the dashboard layout that also mounts the palette.
 */
export const COMMAND_PALETTE_OPEN_EVENT = 'owlat:command-palette-open';

/** The palette's own "Ask knowledge…" verb: opens the palette on its Ask scope. */
export const COMMAND_PALETTE_ASK_EVENT = 'owlat:open-knowledge-query';

/**
 * What a keydown means to the palette: plain Cmd/Ctrl+K toggles it, and
 * Cmd/Ctrl+Shift+K opens it on Ask. Shared by the palette and the layout's
 * pre-mount listener (`useCommandPaletteHost`), so the chord lives in one place.
 */
export function commandPaletteChord(event: KeyboardEvent): 'toggle' | 'ask' | null {
	if (!(event.metaKey || event.ctrlKey) || event.key.toLowerCase() !== 'k') return null;
	return event.shiftKey ? 'ask' : 'toggle';
}

/** Detail carried by the open event. Absent detail means "follow the route". */
export interface CommandPaletteOpenDetail {
	scope?: PaletteScope;
	/**
	 * Text to open with, caret at the end. The mail search page passes its
	 * current query, so refining a search happens in this one box instead of a
	 * second one on the page.
	 */
	query?: string;
}

export interface CommandPaletteControls {
	/** Open the app command palette (no-op on the server). */
	open: (detail?: CommandPaletteOpenDetail) => void;
}

export function useCommandPalette(): CommandPaletteControls {
	function open(detail?: CommandPaletteOpenDetail): void {
		if (!import.meta.client) return;
		window.dispatchEvent(
			new CustomEvent<CommandPaletteOpenDetail>(COMMAND_PALETTE_OPEN_EVENT, {
				detail: detail ?? {},
			})
		);
	}

	return { open };
}
