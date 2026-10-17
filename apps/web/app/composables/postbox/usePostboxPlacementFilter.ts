/**
 * All mail filtered to one Priority placement (read on arrival §3): the
 * Priority view's "N newsletters and promotions · in your digest" opens the
 * inbox list with `?placement=digest`. Client-side over the fetched window,
 * like the triage chips; each row carries its thread's placement.
 *
 * The URL is the state, so the filter survives a reload and Back undoes it;
 * the chip row offers the way out (`clearPostboxPlacementFilter`).
 */
import type { Ref } from 'vue';
import { PLACEMENTS, type Placement } from '@owlat/shared/arrival';

/** `?placement=` as a placement, or null for anything else. */
export function parsePlacementQuery(raw: unknown): Placement | null {
	return typeof raw === 'string' && (PLACEMENTS as readonly string[]).includes(raw)
		? (raw as Placement)
		: null;
}

export function usePostboxPlacementFilter<T extends { placement?: Placement }>(rows: Ref<T[]>) {
	const route = useRoute();
	const placement = computed(() => parsePlacementQuery(route.query['placement']));
	return {
		/** The active placement filter, or null. */
		placement,
		rows: computed(() => {
			const wanted = placement.value;
			return wanted ? rows.value.filter((row) => row.placement === wanted) : rows.value;
		}),
	};
}
