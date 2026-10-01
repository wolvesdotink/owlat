import { nextTick, ref, type Ref } from 'vue';

/** How close to the end still counts as "reading the latest". */
export const FOLLOW_LATEST_THRESHOLD_PX = 80;

/**
 * Keep a scrolling feed pinned to its newest content only while the reader is
 * there (#1050).
 *
 * The feed follows new content while the reader is within
 * {@link FOLLOW_LATEST_THRESHOLD_PX} of the end. Scrolling up past that stops
 * following, and new content then raises `hasNewBelow` instead of moving the
 * view. Scrolling back down, or `jumpToLatest`, resumes following.
 *
 * Only an upward scroll stops following. Content growing below, the composer
 * getting taller, or a smooth scroll on its way down all leave the reader
 * "away from the end" for a moment without them having moved, and none of
 * those should count as scrolling away.
 */
export function useFollowLatest(scrollRef: Ref<HTMLElement | null>) {
	const following = ref(true);
	const hasNewBelow = ref(false);
	let lastScrollTop = 0;

	const distanceFromEnd = (el: HTMLElement) => el.scrollHeight - el.scrollTop - el.clientHeight;

	const onScroll = () => {
		const el = scrollRef.value;
		if (!el) return;
		if (distanceFromEnd(el) <= FOLLOW_LATEST_THRESHOLD_PX) {
			following.value = true;
			hasNewBelow.value = false;
		} else if (el.scrollTop < lastScrollTop) {
			following.value = false;
		}
		lastScrollTop = el.scrollTop;
	};

	const prefersReducedMotion = () =>
		typeof window !== 'undefined' &&
		!!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

	const scrollToEnd = (smooth: boolean) =>
		nextTick(() => {
			const el = scrollRef.value;
			if (!el) return;
			const behavior: ScrollBehavior = smooth && !prefersReducedMotion() ? 'smooth' : 'auto';
			if (typeof el.scrollTo === 'function') el.scrollTo({ top: el.scrollHeight, behavior });
			else el.scrollTop = el.scrollHeight;
		});

	/** New content arrived: follow it, or say it is there. */
	const onContent = () => {
		if (following.value) void scrollToEnd(false);
		else hasNewBelow.value = true;
	};

	/** Go to the newest content and follow from there (the pill, a sent question). */
	const jumpToLatest = (options: { smooth?: boolean } = {}) => {
		following.value = true;
		hasNewBelow.value = false;
		return scrollToEnd(options.smooth ?? true);
	};

	return { following, hasNewBelow, onScroll, onContent, jumpToLatest };
}
