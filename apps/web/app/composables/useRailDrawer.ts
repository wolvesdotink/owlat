/**
 * Is a page's rail drawer (`UiRailDrawer` — chat, the assistant) floating over
 * the page right now?
 *
 * The phone's bottom tab bar sits at `z-(--z-header)`, above the drawer's
 * `z-50` panel and its `z-40` scrim, so the shell hides the bar while its own
 * navigation drawer is open rather than letting it paint over it. This is that
 * same contract for the drawers the shell cannot see: their open state lives in
 * the page, several routes below the layout that mounts the bar, so it travels
 * as shared state instead of the `navigationOpen` prop chain.
 */
import type { ComputedRef } from 'vue';

export interface RailDrawerState {
	/** True while a rail drawer is off-canvas-open, i.e. an overlay. */
	isOpen: ComputedRef<boolean>;
	/** Reported by `UiRailDrawer`; not for callers outside it. */
	setOpen: (open: boolean) => void;
}

export function useRailDrawer(): RailDrawerState {
	const state = useState<boolean>('ui:rail-drawer-open', () => false);

	return {
		isOpen: computed(() => state.value),
		setOpen: (open: boolean) => {
			state.value = open;
		},
	};
}
