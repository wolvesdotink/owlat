/**
 * Lazy mounting for the reader's message bodies.
 *
 * Every expanded message body mounts a sandboxed iframe and runs the sanitize
 * pipeline (PostboxMessageBody.vue). On a long thread most of those bodies sit
 * far below the fold, so the reader renders a placeholder of the body's last
 * measured height instead and swaps the real body in once the placeholder
 * comes near the reader's scroll viewport. A body that has mounted stays
 * mounted.
 *
 * The placeholder keeps its message's place in the layout: the header row,
 * attachments and actions around it render as before, so keyboard focus, Tab
 * order through the message cards and any scroll-to-message jump land where
 * they always did, and focusing or scrolling to a message mounts its body.
 */
import { nextTick, onBeforeUnmount, onMounted, ref, watch, type Ref } from 'vue';
import { findOverflowAncestor } from './usePostboxScrollHost';

/** How far outside the scroll viewport a body starts mounting, in px. */
export const POSTBOX_LAZY_BODY_MARGIN_PX = 600;

/** Placeholder height for a body that has never been measured. */
export const POSTBOX_BODY_PLACEHOLDER_PX = 200;

/** Whether `el` lies within `margin` px of the visible part of `root`. */
export function isNearViewport(el: HTMLElement, root: HTMLElement | null, margin: number): boolean {
	const rect = el.getBoundingClientRect();
	const view = root
		? root.getBoundingClientRect()
		: { top: 0, bottom: window.innerHeight || document.documentElement.clientHeight };
	return rect.bottom >= view.top - margin && rect.top <= view.bottom + margin;
}

/**
 * `mounted` turns true once the placeholder bound to `target` comes within
 * {@link POSTBOX_LAZY_BODY_MARGIN_PX} of the scroll viewport, when `eager`
 * turns true, or right away where IntersectionObserver is missing.
 */
export function usePostboxLazyBody(opts: {
	target: Ref<HTMLElement | null>;
	eager: () => boolean;
}): { mounted: Ref<boolean>; reveal: () => void } {
	const mounted = ref(opts.eager() || typeof IntersectionObserver === 'undefined');
	let observer: IntersectionObserver | null = null;

	function stop() {
		observer?.disconnect();
		observer = null;
	}

	function reveal() {
		mounted.value = true;
		stop();
	}

	watch(opts.eager, (eager) => {
		if (eager) reveal();
	});

	watch(
		opts.target,
		(el) => {
			stop();
			if (!el || mounted.value) return;
			// null: only the document scrolls, so the observer watches the viewport.
			const root = findOverflowAncestor(el);
			// Measured once when the placeholder binds, so a body already on
			// screen mounts in this same flush rather than one observer callback
			// (and one painted placeholder frame) later.
			if (isNearViewport(el, root, POSTBOX_LAZY_BODY_MARGIN_PX)) {
				reveal();
				return;
			}
			observer = new IntersectionObserver(
				(entries) => {
					if (entries.some((entry) => entry.isIntersecting)) reveal();
				},
				{ root, rootMargin: `${POSTBOX_LAZY_BODY_MARGIN_PX}px 0px` }
			);
			observer.observe(el);
		},
		{ immediate: true, flush: 'post' }
	);

	onBeforeUnmount(stop);

	return { mounted, reveal };
}

/** Resolves once every srcdoc frame under `root` has loaded, or after `timeoutMs`. */
export function waitForFrameLoads(root: HTMLElement | null, timeoutMs: number): Promise<void> {
	if (!root) return Promise.resolve();
	const pending = Array.from(root.querySelectorAll('iframe')).filter((frame) => {
		const doc = frame.contentDocument;
		return !(doc && doc.URL === 'about:srcdoc' && doc.readyState === 'complete');
	});
	if (pending.length === 0) return Promise.resolve();
	return new Promise((resolve) => {
		let left = pending.length;
		const timer = setTimeout(resolve, timeoutMs);
		for (const frame of pending) {
			frame.addEventListener(
				'load',
				() => {
					if (--left === 0) {
						clearTimeout(timer);
						resolve();
					}
				},
				{ once: true }
			);
		}
	});
}

const PRINT_FRAME_TIMEOUT_MS = 1500;

/**
 * Printing wants every expanded body on paper, not placeholders. `mountAll`
 * flips on the browser's own print (beforeprint, best effort) and through
 * `preparePrint`, which the reader's print action awaits: it mounts every body
 * and waits for their frames. Returns undefined when everything is already
 * mounted, so the action can print straight away.
 */
export function usePostboxMountAllBodies(opts: {
	threadKey: () => string;
	root: Ref<HTMLElement | null>;
}): { mountAll: Ref<boolean>; preparePrint: () => Promise<void> | undefined } {
	const mountAll = ref(false);
	watch(opts.threadKey, () => {
		mountAll.value = false;
	});

	const onBeforePrint = () => {
		mountAll.value = true;
	};
	onMounted(() => window.addEventListener('beforeprint', onBeforePrint));
	onBeforeUnmount(() => window.removeEventListener('beforeprint', onBeforePrint));

	function preparePrint(): Promise<void> | undefined {
		if (mountAll.value) return undefined;
		mountAll.value = true;
		return nextTick().then(() => waitForFrameLoads(opts.root.value, PRINT_FRAME_TIMEOUT_MS));
	}

	return { mountAll, preparePrint };
}
