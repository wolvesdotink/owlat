/**
 * The list pane's ONE banner slot, and the visibility of the three strips that
 * compete for it.
 *
 * Three independent components each decided for themselves whether to render,
 * so an offline device on a sealed instance with a non-empty reply queue got a
 * three-high stack of advisory strips above the first message. They are now
 * ordered and shown one at a time:
 *
 *   offline > sealed > reply queue
 *
 * Connectivity first because it changes what the rest of the UI can promise;
 * the sealed nudge next because it is one-time and its dismissal is a server
 * write; the reply-queue strip last because it is the only one with a permanent
 * second home — the folder rail carries its live count regardless, so nothing
 * is hidden when its banner yields.
 *
 * Yielding is not losing: each predicate stays live, so the moment the higher
 * banner is dismissed (sealed) or resolves (back online, queue drained) the next
 * one takes the slot.
 *
 * The predicates live here rather than inside each component so the slot and the
 * strip it renders cannot disagree about whether that strip is visible — each
 * component reads the same computed the ordering does.
 */

import type { Ref } from 'vue';
import type { Id } from '@owlat/api/dataModel';

export type PostboxBannerKind = 'offline' | 'sealed' | 'replyQueue';

/**
 * The one-time "your mail is sealed" nudge. `hasSeenSealedMailNudge` is a
 * per-user server preference, so "shown once" means once per person rather than
 * once per browser.
 */
export function usePostboxSealedNudge() {
	const { isEnabled } = useFeatureFlag();
	const { hasSeenSealedMailNudge, dismissSealedMailNudge } = usePostboxSettings();
	const visible = computed(() => isEnabled('sealedMail') && !hasSeenSealedMailNudge.value);
	return { visible, dismiss: dismissSealedMailNudge };
}

/**
 * The "waiting on your reply" strip: inbox only, non-empty queue only, and
 * dismissible for the session (in-memory state, resets on reload).
 */
export function usePostboxReplyQueueBanner(
	mailboxId: Ref<Id<'mailboxes'>>,
	folderRole: Ref<string>
) {
	const { count } = usePostboxReplyQueue(mailboxId);
	const dismissed = useState('postbox:reply-queue-strip-dismissed', () => false);
	const visible = computed(
		() => folderRole.value === 'inbox' && count.value > 0 && !dismissed.value
	);
	return { visible, count, dismissed };
}

/** Which of the three strips owns the slot right now, if any. */
export function usePostboxBannerSlot(args: {
	isOffline: Ref<boolean>;
	/** Sends the reconnect drain could not deliver — the online half of the strip. */
	failedCount: Ref<number>;
	mailboxId: Ref<Id<'mailboxes'>>;
	folderRole: Ref<string>;
}) {
	const sealed = usePostboxSealedNudge();
	const replyQueue = usePostboxReplyQueueBanner(args.mailboxId, args.folderRole);
	// PostboxOfflineBanners renders exactly one of its two strips, and nothing at
	// all when the device is online with an empty failed queue.
	const offlineVisible = computed(() => args.isOffline.value || args.failedCount.value > 0);

	const active = computed<PostboxBannerKind | null>(() => {
		if (offlineVisible.value) return 'offline';
		if (sealed.visible.value) return 'sealed';
		if (replyQueue.visible.value) return 'replyQueue';
		return null;
	});

	return { active };
}
