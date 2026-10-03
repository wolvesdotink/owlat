/**
 * "Insert availability" in the composer's ⋯ menu: put the sender's next open
 * times and their booking link into the message, after what they have written
 * and above the signature and the quoted original.
 *
 * The times come from the booking page (`booking.hostBookings.availabilitySnippet`,
 * the first active meeting type), read when the item is clicked rather than
 * subscribed in every open composer. With no booking page set up yet, a toast
 * says so and offers the settings page.
 *
 * Owned by the composer footer, not by the menu item: the ⋯ panel unmounts on
 * the click that starts the read, so the read must outlive it.
 */
import { computed, ref, type Ref } from 'vue';
import { api } from '@owlat/api';
import { splitAnswerBody } from '~/utils/answerDraft';
import { availabilityHtml } from '~/utils/bookingSlots';

export function usePostboxInsertAvailability(bodyHtml: Ref<string>) {
	const { t, locale } = useI18n();
	const { isEnabled } = useFeatureFlag();
	const { showToast } = useToast();

	const isAvailable = computed(() => isEnabled('calendar.booking'));
	const isInserting = ref(false);

	async function insertAvailability(): Promise<void> {
		if (isInserting.value) return;
		isInserting.value = true;
		let snippet;
		try {
			snippet = await requireConvex().query(api.booking.hostBookings.availabilitySnippet, {});
		} catch {
			showToast(t('components.postbox.postboxInsertAvailability.loadFailed'), 'error');
			return;
		} finally {
			isInserting.value = false;
		}
		if (!snippet) {
			showToast(t('components.postbox.postboxInsertAvailability.notSetUp'), 'info', {
				action: {
					label: t('components.postbox.postboxInsertAvailability.setUp'),
					onAction: () => void navigateTo('/dashboard/preferences/booking'),
				},
			});
			return;
		}
		const html = availabilityHtml(
			snippet,
			{
				intro:
					snippet.slots.length > 0
						? t('components.postbox.postboxInsertAvailability.intro', { zone: snippet.timeZone })
						: t('components.postbox.postboxInsertAvailability.introNoTimes'),
				linkLead: t('components.postbox.postboxInsertAvailability.linkLead'),
			},
			locale.value
		);
		const { fresh, tail } = splitAnswerBody(bodyHtml.value);
		bodyHtml.value = `${fresh}${html}${tail}`;
	}

	return { isAvailable, isInserting, insertAvailability };
}
