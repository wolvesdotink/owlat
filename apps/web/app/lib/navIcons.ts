/**
 * The filled glyph a navigation destination shows while it is the current page.
 *
 * A sidebar row, a rail button, a tab and a folder all mark the current page
 * with the brand colour; the filled glyph is the second cue, the one that still
 * reads where colour does not (high-contrast themes, colour-blind users, a
 * glance at the rail). Idle rows keep the line glyph, so the filled one stands
 * out instead of competing with a column of solid shapes.
 *
 * Only the primary navigation's destinations are listed (the sidebar, the
 * rails, the tab bar, Postbox folders), so the fill set adds those glyphs to
 * the dashboard layout and nothing more. The settings lists mark their current
 * entry with colour and weight alone: their fifty-odd fills would cost every
 * settings page more than the cue is worth. An icon without an entry keeps its
 * line glyph when active, which is the right fallback for a plugin entry or a
 * destination added later: still coloured, never blank.
 *
 * The fills load on demand (`lib/navIconFills.ts`): only the current page's
 * destination shows one, so the forty-odd glyphs stay off every page's first
 * download. Until they arrive the active entry shows its line glyph, already
 * in the brand colour, and swaps once.
 */
import { shallowRef } from 'vue';
import type { IconComponent } from '@coolicons/vue';

const fills = shallowRef<ReadonlyMap<IconComponent, IconComponent> | null>(null);
let loading: Promise<void> | null = null;

/** Load the fill glyphs once; every later call returns the same promise. */
export function loadNavIconFills(): Promise<void> {
	loading ??= import('./navIconFills').then(({ FILLED }) => {
		fills.value = FILLED;
	});
	return loading;
}

/** `icon`, or its filled counterpart when the destination it marks is the current page. */
export function navIcon(icon: IconComponent, active: boolean): IconComponent {
	if (!active) return icon;
	if (!fills.value) {
		void loadNavIconFills();
		return icon;
	}
	return fills.value.get(icon) ?? icon;
}
