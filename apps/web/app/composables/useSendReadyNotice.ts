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
 * Because it goes away for good, the toast is STICKY and the acknowledge waits
 * for the dismissal, not the render: a once-ever notice that spent three
 * seconds on screen while the member was reading something else is a notice
 * they never received, and it is already marked as delivered.
 *
 * Mounted once from the dashboard layout.
 */
export function useSendReadyNotice() {
	const { t } = useI18n();
	const { showToast } = useToast();

	const { data } = useOrganizationQuery(api.auth.sendReadyNotices.getState);
	const { run: acknowledge } = useBackendOperation(api.auth.sendReadyNotices.acknowledge, {
		label: () => t('shared.useSendReadyNotice.acknowledgeOperation'),
	});

	// Ids covered by a toast this session. Guards the window between showing the
	// toast and the acknowledge write landing, during which the query still
	// reports the notices as pending — and with the acknowledge now waiting for
	// a dismissal, that window is as long as the member leaves the toast up.
	// Every id in the burst is recorded, not just the one the toast names: they
	// all say the same thing, so a re-report must not toast the older rows again.
	const surfaced = new Set<string>();

	watch(
		() => data.value,
		(state) => {
			const pending = (state?.notices as SendReadyNotice[] | undefined) ?? [];
			const notice = planSendReadyToast(pending, surfaced);
			if (!notice) return;
			for (const covered of pending) surfaced.add(covered.id);

			// `sendReadyToastMessage()` is written where the notice is planned, at
			// module scope, so it hands back a message KEY rather than a sentence.
			showToast(t(sendReadyToastMessage()), 'success', {
				// Sticky: this one never comes back, so it waits to be read.
				durationMs: 0,
				action: {
					label: t('shared.useSendReadyNotice.finishSetup'),
					onAction: () => void navigateTo(SEND_READY_DEEP_LINK),
				},
				// Fires once, on the close button, the action button, or a clear —
				// so "acknowledged" means the member actually dealt with it.
				onDismiss: () => void acknowledge({}),
			});
		},
		{ immediate: true, deep: true }
	);
}
