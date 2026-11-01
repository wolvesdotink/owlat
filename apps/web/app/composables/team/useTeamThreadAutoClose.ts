import { computed, ref, type Ref } from 'vue';
import { api } from '@owlat/api';
import type { Id } from '@owlat/api/dataModel';
import type { useThreadDetail } from '~/composables/useThreadDetail';
import { threadAutoCloseFact, threadAutoCloseSwitch } from '~/utils/inboxAutoClose';

/**
 * Auto-close on a Team Inbox thread: the rule's state for this thread (when it
 * will close, whether it opted out), the switch in the header's ⋯ menu, and
 * the Reopen on the notice over a thread the sweep resolved.
 */
export function useTeamThreadAutoClose(options: {
	threadId: Ref<Id<'conversationThreads'>>;
	isAdmin: Ref<boolean>;
	detail: Pick<ReturnType<typeof useThreadDetail>, 'handleStatusChange' | 'handleSetAutoClose'>;
}) {
	const { t } = useI18n();
	const { showToast } = useToast();

	const { data: autoClose } = useConvexQuery(api.inbox.autoClose.getThreadAutoClose, () =>
		options.isAdmin.value ? { threadId: options.threadId.value } : 'skip'
	);
	const autoCloseSwitch = computed(() => threadAutoCloseSwitch(autoClose.value ?? null));
	const autoCloseFact = computed(() => threadAutoCloseFact(autoClose.value ?? null));
	const isReopening = ref(false);

	async function onReopen() {
		isReopening.value = true;
		try {
			const result = await options.detail.handleStatusChange('open');
			if (result.ok) showToast(t('dashboard.inbox.detail.autoClose.reopenedToast'));
		} finally {
			isReopening.value = false;
		}
	}

	async function onAutoClose(isDisabled: boolean) {
		const result = await options.detail.handleSetAutoClose(isDisabled);
		if (result.ok && result.result.changed) {
			showToast(
				t(
					isDisabled
						? 'dashboard.inbox.detail.autoClose.turnedOffToast'
						: 'dashboard.inbox.detail.autoClose.turnedOnToast'
				)
			);
		}
	}

	return { autoClose, autoCloseSwitch, autoCloseFact, isReopening, onReopen, onAutoClose };
}
