/**
 * Its own module so the Postbox pages that only need a bar's height do not
 * import the reader's sticky-bar geometry, and with it the chunk the reader
 * shares with the rest of its code.
 */
import { getCurrentInstance, onBeforeUnmount, ref, watch, type Ref } from 'vue';

/**
 * The border-box height of `target`, kept current by a ResizeObserver. An
 * element that is not rendered (`display: none`) measures 0.
 */
export function useBlockSize(target: () => HTMLElement | null | undefined): Ref<number> {
	const size = ref(0);
	let observer: ResizeObserver | null = null;
	const stop = () => {
		observer?.disconnect();
		observer = null;
	};
	watch(
		target,
		(el) => {
			stop();
			size.value = el ? el.offsetHeight : 0;
			if (!el || typeof ResizeObserver === 'undefined') return;
			observer = new ResizeObserver(() => {
				size.value = el.offsetHeight;
			});
			observer.observe(el);
		},
		{ immediate: true, flush: 'post' }
	);
	if (getCurrentInstance()) onBeforeUnmount(stop);
	return size;
}
