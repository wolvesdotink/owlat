/**
 * A fixed-row-height window for a list that scrolls with its page rather than
 * inside a box of its own (the Postbox contacts page). It finds the scroller
 * the list sits in once the list mounts, windows against the part of that
 * scroller the list occupies, and follows its scroll one derivation per frame.
 * The list's own box keeps the full height, so the scrollbar still spans every
 * row.
 */
import { onBeforeUnmount, shallowRef, watch, type Ref } from 'vue';
import { createRafThrottle, usePostboxVirtualList } from './usePostboxVirtualList';
import { findScrollParent, usePostboxScrollEvent } from './usePostboxScrollHost';

export function usePostboxHostedVirtualList(opts: {
	listEl: Ref<HTMLElement | null>;
	itemCount: Ref<number>;
	rowHeight: Ref<number>;
	enabled: Ref<boolean>;
	overscan?: number;
}) {
	const scrollHost = shallowRef<HTMLElement | null>(null);
	watch(
		opts.listEl,
		(el) => {
			scrollHost.value = el ? findScrollParent(el) : null;
		},
		{ immediate: true, flush: 'post' }
	);

	const list = usePostboxVirtualList({ ...opts, scrollEl: scrollHost });
	const throttle = createRafThrottle(list.syncScroll);
	usePostboxScrollEvent(scrollHost, throttle.schedule);
	onBeforeUnmount(() => throttle.cancel());

	return { ...list, scrollHost };
}
