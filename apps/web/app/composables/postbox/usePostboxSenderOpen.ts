import { getCurrentInstance, onBeforeUnmount, ref, watch, type Ref } from 'vue';
import { api } from '@owlat/api';
import type { Id } from '@owlat/api/dataModel';
import { isNearViewport } from './usePostboxLazyBody';
import { findOverflowAncestor } from './usePostboxScrollHost';

/**
 * Tell the server a message's body was shown (SPEC §5): its sender's "you
 * read" counter counts the first open of live mail. Called by every reader
 * message card, so an older message expanded by hand, a citation that opens
 * one, or a reply that arrives while the thread is open each count when their
 * body is on screen, and a collapsed header never does. `isShown` must mean
 * the body is really visible (see {@link useElementShownOnce}): an expanded
 * card whose body is still the lazy placeholder, or mounted but scrolled off
 * screen, is not a read. Once per message per mount (the server dedupes too),
 * whatever the mark-read policy, and silent: a failed count is not the
 * reader's problem. Bulk and collapsed mark-read never go through here.
 */
export function usePostboxSenderOpen(messageId: () => string, isShown: () => boolean) {
	const { t } = useI18n();
	const markOpenedOp = useBackendOperation(api.mail.senders.opens.markOpened, {
		label: () => t('postbox.senders.operations.markOpened'),
		announce: false,
		onError: () => true,
	});
	const counted = new Set<string>();
	watch(
		() => [messageId(), isShown()] as const,
		([id, shown]) => {
			if (!shown || !id || counted.has(id)) return;
			counted.add(id);
			void markOpenedOp.run({ messageId: id as Id<'mailMessages'> });
		},
		{ immediate: true }
	);
}

/**
 * Turns true, and stays true, once `target` intersects the visible part of
 * its scroll viewport (no margin: near is not shown). A null target (nothing
 * rendered yet, e.g. the lazy body's placeholder) is never shown; a new
 * element is watched afresh. Without IntersectionObserver it decides once,
 * by geometry, when the element binds.
 */
export function useElementShownOnce(target: Ref<HTMLElement | null>): Ref<boolean> {
	const shown = ref(false);
	let observer: IntersectionObserver | null = null;
	const stop = () => {
		observer?.disconnect();
		observer = null;
	};
	watch(
		target,
		(el) => {
			stop();
			if (!el || shown.value) return;
			const root = findOverflowAncestor(el);
			if (isNearViewport(el, root, 0)) {
				shown.value = true;
				return;
			}
			if (typeof IntersectionObserver === 'undefined') return;
			observer = new IntersectionObserver(
				(entries) => {
					if (!entries.some((entry) => entry.isIntersecting)) return;
					shown.value = true;
					stop();
				},
				{ root, threshold: 0 }
			);
			observer.observe(el);
		},
		{ immediate: true, flush: 'post' }
	);
	if (getCurrentInstance()) onBeforeUnmount(stop);
	return shown;
}
