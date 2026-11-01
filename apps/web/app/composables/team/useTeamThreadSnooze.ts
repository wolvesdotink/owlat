import { computed, ref, type Ref } from 'vue';
import type { useThreadDetail } from '~/composables/useThreadDetail';

/**
 * Snoozing a Team Inbox thread: the picker (which reuses the Postbox snooze
 * presets, PostboxSnoozeDialog), whether it is snoozed now, and the snooze /
 * unsnooze writes with their success toasts. A failure is toasted by the
 * operation itself, so only success is said here.
 */
export function useTeamThreadSnooze(options: {
	thread: Ref<{ snoozedUntil?: number } | null | undefined>;
	detail: Pick<ReturnType<typeof useThreadDetail>, 'handleSnooze' | 'handleUnsnooze'>;
}) {
	const { t } = useI18n();
	const { showToast } = useToast();

	const showSnoozeDialog = ref(false);
	const isSnoozed = computed(
		() => !!options.thread.value?.snoozedUntil && options.thread.value.snoozedUntil > Date.now()
	);

	const onSnoozeConfirm = async (timestamp: number) => {
		showSnoozeDialog.value = false;
		const result = await options.detail.handleSnooze(timestamp);
		if (result.ok) showToast(t('dashboard.inbox.detail.snoozedToast'));
	};
	// "Until they reply" maps to a capped snooze: an inbound reply already
	// resurfaces a snoozed thread (the thread module's inbound_activity reducer
	// clears the snooze), so the cap is just the no-reply fallback.
	const onSnoozeUntilReply = async (capTimestamp: number) => {
		showSnoozeDialog.value = false;
		const result = await options.detail.handleSnooze(capTimestamp);
		if (result.ok) showToast(t('dashboard.inbox.detail.snoozedUntilReplyToast'));
	};
	const onUnsnooze = async () => {
		const result = await options.detail.handleUnsnooze();
		if (result.ok) showToast(t('dashboard.inbox.detail.unsnoozedToast'));
	};

	return { showSnoozeDialog, isSnoozed, onSnoozeConfirm, onSnoozeUntilReply, onUnsnooze };
}
