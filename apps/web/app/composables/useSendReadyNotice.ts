import { api } from '@owlat/api';
import {
	planSendReadyToast,
	sendReadyToastMessage,
	SEND_READY_DEEP_LINK,
	type SendReadyNotice,
} from '~/lib/onboarding/sendReadyNotice';

/**
 * The in-app half of "you can send now".
 *
 * A member who onboarded before the instance had an outbound transport was told
 * the truth — "your admin is still setting up sending" — and their first-send
 * step stayed open. The backend writes them a `sendReadyNotices` row the moment
 * that changes (`auth/sendReadyNotices.ts`); this composable turns that row into
 * ONE toast deep-linking to the step, then acknowledges it server-side so the
 * nudge never repeats on the next page load.
 *
 * Acknowledgement is a server write rather than session memory on purpose: the
 * member is usually not in the app when the transport lands, so the notice has
 * to wait for them across sessions — and then go away for good.
 *
 * Mounted once from the dashboard layout.
 */
export function useSendReadyNotice() {
	const { showToast } = useToast();

	const { data } = useOrganizationQuery(api.auth.sendReadyNotices.getState);
	const { run: acknowledge } = useBackendOperation(api.auth.sendReadyNotices.acknowledge, {
		label: 'Acknowledge sending-ready notice',
	});

	// Ids toasted this session. Guards the window between showing the toast and
	// the acknowledge write landing, during which the query still reports the
	// notice as pending.
	const surfaced = new Set<string>();

	watch(
		() => data.value,
		async (state) => {
			const notice = planSendReadyToast(state?.notices as SendReadyNotice[] | undefined, surfaced);
			if (!notice) return;
			surfaced.add(notice.id);

			showToast(sendReadyToastMessage(), 'success', {
				action: {
					label: 'Finish setup',
					onAction: () => void navigateTo(SEND_READY_DEEP_LINK),
				},
			});
			await acknowledge({});
		},
		{ immediate: true, deep: true }
	);

	return { isSendPathReady: computed(() => data.value?.isReady ?? false) };
}
