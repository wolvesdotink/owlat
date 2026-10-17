/**
 * All mail filtered to one Priority placement (read on arrival §3): the
 * Priority view's "N newsletters and promotions · in your digest" opens the
 * inbox list with `?placement=digest`. Client-side over the fetched window,
 * like the triage chips; each row carries its thread's placement.
 *
 * The URL is the state, so the filter survives a reload and Back undoes it;
 * the chip row offers the way out. Every route the filtered list opens or
 * returns to keeps it: the layout provides the `?placement=` suffix
 * (`POSTBOX_LIST_QUERY`), and row links, keyboard activation, the reader's
 * advance and close, and the back bar append it (`usePostboxListQuery`).
 */
import { computed, inject, provide, type InjectionKey, type Ref } from 'vue';
import { PLACEMENTS, type Placement } from '@owlat/shared/arrival';

/** `?placement=` as a placement, or null for anything else. */
export function parsePlacementQuery(raw: unknown): Placement | null {
	return typeof raw === 'string' && (PLACEMENTS as readonly string[]).includes(raw)
		? (raw as Placement)
		: null;
}

/** The query a list route carries for `placement`: `?placement=digest`, or ''. */
export function placementQuerySuffix(placement: Placement | null): string {
	return placement ? `?placement=${placement}` : '';
}

export const POSTBOX_LIST_QUERY: InjectionKey<Readonly<Ref<string>>> = Symbol('postboxListQuery');

const NO_QUERY: Readonly<Ref<string>> = computed(() => '');

/** The query to keep on routes the list opens or returns to ('' outside a filtered list). */
export function usePostboxListQuery(): Readonly<Ref<string>> {
	return inject(POSTBOX_LIST_QUERY, NO_QUERY);
}

export function usePostboxPlacementFilter<T extends { placement?: Placement }>(rows: Ref<T[]>) {
	const route = useRoute();
	const placement = computed(() => parsePlacementQuery(route.query['placement']));
	provide(
		POSTBOX_LIST_QUERY,
		computed(() => placementQuerySuffix(placement.value))
	);
	return {
		/** The active placement filter, or null. */
		placement,
		rows: computed(() => {
			const wanted = placement.value;
			return wanted ? rows.value.filter((row) => row.placement === wanted) : rows.value;
		}),
	};
}
