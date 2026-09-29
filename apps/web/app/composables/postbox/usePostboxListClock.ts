/**
 * One clock per Postbox list, shared by every row under it.
 *
 * Row timestamps ("5m", "3h") used to read `Date.now()` once, at render, and
 * never again: a row that said "just now" at nine still said it at noon unless
 * something else happened to re-render it. A clock per row would fix that at
 * the price of one interval per visible row. Instead the list starts a single
 * minute clock and provides it; each row injects it, so the whole list ticks
 * once a minute off one timer.
 *
 * Nested lists (the Today view's two thread lists, a sectioned list inside the
 * layout) reuse the nearest ancestor's clock instead of starting their own.
 */
import { inject, provide, shallowRef, type InjectionKey, type Ref } from 'vue';
import { useNow } from '~/composables/useNow';
import { formatThreadTimestamp } from '~/utils/postboxThreadTimestamp';

/** A minute: the smallest unit a row timestamp shows. */
export const POSTBOX_LIST_CLOCK_INTERVAL_MS = 60_000;

const POSTBOX_LIST_NOW_KEY: InjectionKey<Readonly<Ref<number>>> = Symbol('postboxListNow');

/**
 * The list side: reuse an ancestor list's clock, or start one and hand it to
 * everything rendered below. Returns the clock (epoch ms) for the list's own
 * time-dependent reads.
 */
export function usePostboxListNow(): Readonly<Ref<number>> {
	const inherited = inject(POSTBOX_LIST_NOW_KEY, null);
	if (inherited) return inherited;
	const now = useNow({ intervalMs: POSTBOX_LIST_CLOCK_INTERVAL_MS });
	provide(POSTBOX_LIST_NOW_KEY, now);
	return now;
}

/**
 * The row side: a timestamp formatter bound to the list's clock and the active
 * locale. A component that is itself the list passes the clock it got from
 * `usePostboxListNow` (a component cannot inject what it provided).
 *
 * A row mounted outside any list gets the time it mounted at and keeps it. That
 * is the old behaviour, and cheaper than a stray interval per orphan row.
 */
export function usePostboxThreadTimestamp(
	clock?: Readonly<Ref<number>>
): (timestamp: number) => string {
	const now = clock ?? inject(POSTBOX_LIST_NOW_KEY, null) ?? shallowRef(Date.now());
	const { t, locale } = useI18n();
	return (timestamp) =>
		formatThreadTimestamp(timestamp, {
			now: now.value,
			locale: locale.value,
			justNow: t('components.postbox.postboxThreadRow.justNow'),
		});
}
