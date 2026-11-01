/**
 * What opening a conversation in PostboxThreadReader marks: the thread read,
 * under the person's mark-read policy, and the one-shot back-from-snooze cue
 * cleared.
 */
import { computed, onBeforeUnmount, watch, type Ref } from 'vue';
import { api } from '@owlat/api';
import type { Id } from '@owlat/api/dataModel';
import {
	POSTBOX_MARK_READ_DWELL_MS,
	markReadOnOpen,
	showsManualMarkRead,
	type PostboxMarkReadPolicy,
} from '~/utils/postboxMarkReadPolicy';
import { optimisticMarkThreadRead } from '~/lib/mailOptimistic/mailUpdaters';

export function usePostboxReaderMarkRead(source: {
	/** The id of the message the reader is open on. */
	messageId: () => string;
	/** The thread page query's answer, whose `thread` is the open thread. */
	threadData: () => { thread?: { _id: string } | null } | null | undefined;
	/** True while the open thread still has an unread message. */
	hasUnread: Ref<boolean>;
	policy: Ref<PostboxMarkReadPolicy>;
}) {
	const { t } = useI18n();

	// Mark-as-read on open under markReadPolicy: 'immediate' on render (also unset),
	// 'after-dwell' after POSTBOX_MARK_READ_DWELL_MS of visible dwell (cancelled on
	// leave), 'manual' never (the ⋯ menu offers it). Guarded per thread so the
	// re-fetch that follows does not re-fire; optimistic, so the row's bold clears at once.
	const markThreadReadOp = useBackendOperation(api.mail.messageActions.markThreadRead, {
		label: () => t('components.postbox.postboxThreadReader.markReadOperation'),
		optimisticUpdate: optimisticMarkThreadRead,
	});
	const markedThreads = new Set<string>();
	let dwellTimer: ReturnType<typeof setTimeout> | undefined;

	function cancelDwell() {
		if (dwellTimer !== undefined) {
			clearTimeout(dwellTimer);
			dwellTimer = undefined;
		}
	}

	function runMarkThreadRead(threadId: string) {
		void markThreadReadOp.run({ threadId: threadId as Id<'mailThreads'>, seen: true });
	}

	/** True while the open thread still has an unread message (drives the button). */
	const showsManualMarkReadButton = computed(() =>
		showsManualMarkRead(source.policy.value, source.hasUnread.value)
	);

	/** The thread menu's explicit "Mark read" item (markReadPolicy 'manual'). */
	function markOpenThreadRead() {
		const threadId = source.threadData()?.thread?._id;
		if (!threadId) return;
		markedThreads.add(threadId);
		runMarkThreadRead(threadId);
	}

	watch(
		source.threadData,
		(data) => {
			const thread = data?.thread;
			if (!thread) return;
			if (markedThreads.has(thread._id)) return;
			if (!source.hasUnread.value) return;
			const mode = markReadOnOpen(source.policy.value);
			if (mode === 'never') return;
			markedThreads.add(thread._id);
			if (mode === 'now') {
				runMarkThreadRead(thread._id);
				return;
			}
			// 'after-dwell': a j/k skim past a row or a mis-click never burns the
			// unread flag, because leaving the reader clears the timer.
			cancelDwell();
			const threadId = thread._id;
			dwellTimer = setTimeout(() => {
				dwellTimer = undefined;
				runMarkThreadRead(threadId);
			}, POSTBOX_MARK_READ_DWELL_MS);
		},
		{ immediate: true }
	);
	// Navigating to another conversation (or unmounting) cancels a pending dwell,
	// and re-arms for the newly opened thread through the watcher above.
	watch(source.messageId, () => cancelDwell());
	onBeforeUnmount(cancelDwell);

	// Back-from-snooze marker (mail/snooze.ts): a one-shot recognition cue, so
	// opening the thread is what dismisses it. Fired once per thread per mount;
	// the mutation is idempotent server-side.
	const clearSnoozeReturnedOp = useBackendOperation(api.mail.snooze.clearSnoozeReturned, {
		label: () => t('components.postbox.postboxThreadReader.clearSnoozeReturnedOperation'),
	});
	const clearedSnoozeReturned = new Set<string>();
	watch(
		() => source.threadData()?.thread,
		(thread) => {
			const t2 = thread as { _id: string; snoozeReturnedAt?: number } | null | undefined;
			if (!t2?.snoozeReturnedAt) return;
			if (clearedSnoozeReturned.has(t2._id)) return;
			clearedSnoozeReturned.add(t2._id);
			void clearSnoozeReturnedOp.run({ threadId: t2._id as Id<'mailThreads'> });
		},
		{ immediate: true }
	);

	return { markThreadReadOp, showsManualMarkReadButton, markOpenThreadRead };
}
