<script setup lang="ts">
/**
 * The public booking page for one meeting: `/book/<host>/<meeting>`.
 *
 * Opened by someone who got the link in an email, mostly on a phone, with no
 * Owlat account. Three steps on one page: pick a time (in the visitor's own
 * time zone, detected and switchable), enter name and email, see it booked.
 * The server re-checks the time when it books; a time someone else took in
 * the meantime sends the visitor back to the calendar with fresh times.
 */
import { getTzParts } from '@owlat/shared/ical';
import RecipientStateCard from '~/components/recipient/RecipientStateCard.vue';
import RecipientFooter from '~/components/recipient/RecipientFooter.vue';
import BookingMeetingSummary from '~/components/booking/BookingMeetingSummary.vue';
import BookingSlotPicker from '~/components/booking/BookingSlotPicker.vue';
import BookingGuestForm from '~/components/booking/BookingGuestForm.vue';
import {
	bookMeeting,
	fetchMeetingPage,
	type BookedMeeting,
	type MeetingPageData,
} from '~/lib/bookingClient';
import { browserTimeZone, formatSlotRange, monthWindow } from '~/utils/bookingSlots';
import { bookingErrorKey, isUnreachableReason } from '~/utils/bookingErrors';

definePageMeta({ layout: false });

const { t, locale } = useI18n();
const route = useRoute();
const hostSlug = computed(() => String(route.params.user ?? ''));
const typeSlug = computed(() => String(route.params.type ?? ''));

const timeZone = ref(browserTimeZone());
const today = getTzParts(Date.now(), timeZone.value);
const month = ref({ year: today.year, month: today.month });

const page = ref<MeetingPageData | null>(null);
/** Why the page could not load: the raw reason, for heading and message. */
const pageReason = ref<string | null>(null);
const loadingTimes = ref(true);
const selected = ref<number | null>(null);
const step = ref<'pick' | 'details' | 'booked'>('pick');
const submitting = ref(false);
const formError = ref<string | null>(null);
const booked = ref<{ meeting: BookedMeeting; email: string } | null>(null);

useSeoMeta({
	title: () =>
		page.value
			? t('booking.page.seoTitle', {
					meeting: page.value.meetingType.title,
					host: page.value.host.name,
				})
			: t('booking.page.pageTitle'),
	robots: 'noindex',
});

let requestId = 0;
async function loadTimes() {
	const id = ++requestId;
	loadingTimes.value = true;
	const window = monthWindow(month.value.year, month.value.month, timeZone.value);
	const result = await fetchMeetingPage(hostSlug.value, typeSlug.value, window);
	if (id !== requestId) return;
	loadingTimes.value = false;
	if (!result.ok) {
		if (!page.value) pageReason.value = result.reason;
		return;
	}
	page.value = result.data;
}

onMounted(loadTimes);
watch([month, timeZone], loadTimes);

watch(selected, (start) => {
	if (start !== null) {
		formError.value = null;
		step.value = 'details';
	}
});

async function submit(details: { name: string; email: string; note: string; website: string }) {
	if (selected.value === null) return;
	submitting.value = true;
	formError.value = null;
	const result = await bookMeeting(hostSlug.value, {
		type: typeSlug.value,
		start: selected.value,
		name: details.name.trim(),
		email: details.email.trim(),
		note: details.note.trim() || undefined,
		timeZone: timeZone.value,
		locale: locale.value,
		website: details.website,
	});
	submitting.value = false;
	if (result.ok) {
		booked.value = { meeting: result.data.booking, email: details.email.trim() };
		step.value = 'booked';
		return;
	}
	formError.value = bookingErrorKey(result.reason, 'booking.errors.bookFailed');
	if (result.reason === 'slot_taken') {
		// Someone was faster: back to the calendar, with the time gone from it.
		selected.value = null;
		step.value = 'pick';
		await loadTimes();
	}
}

function back() {
	selected.value = null;
	step.value = 'pick';
}
</script>

<template>
	<div
		class="flex min-h-dvh flex-col items-center gap-8 bg-bg-deep px-5 pt-[max(2.5rem,env(safe-area-inset-top))] pb-[max(2.5rem,env(safe-area-inset-bottom))] text-text-primary"
	>
		<div v-if="!page" class="flex flex-1 items-center">
			<RecipientStateCard
				v-if="!pageReason"
				variant="loading"
				:message="t('booking.page.loading')"
			/>
			<RecipientStateCard
				v-else
				variant="error"
				:heading="
					isUnreachableReason(pageReason)
						? t('booking.page.unreachableHeading')
						: t('booking.page.notFoundHeading')
				"
				:message="t(bookingErrorKey(pageReason, 'booking.errors.notFound'))"
			/>
		</div>

		<RecipientStateCard
			v-else-if="step === 'booked' && booked"
			variant="success"
			width="lg"
			:heading="t('booking.page.bookedHeading')"
			class="mt-[10vh]"
		>
			<p class="mb-2 break-words text-text-primary" data-testid="booking-confirmation">
				{{ booked.meeting.title }} ·
				{{ formatSlotRange(booked.meeting.startAt, booked.meeting.endAt, locale, timeZone) }}
			</p>
			<p class="text-sm break-words text-text-secondary">
				{{ t('booking.page.bookedBody', { email: booked.email }) }}
			</p>
		</RecipientStateCard>

		<main
			v-else
			class="card grid w-full max-w-4xl gap-8 p-6 md:grid-cols-[16rem_minmax(0,1fr)] md:p-8"
		>
			<BookingMeetingSummary :host="page.host" :meeting="page.meetingType" />
			<section :aria-label="t('booking.page.pickHeading')">
				<h2 class="mb-4 text-lg font-semibold">
					{{ step === 'pick' ? t('booking.page.pickHeading') : t('booking.page.detailsHeading') }}
				</h2>
				<p v-if="step === 'pick' && formError" class="mb-4 text-sm text-error" role="alert">
					{{ t(formError) }}
				</p>
				<BookingSlotPicker
					v-if="step === 'pick'"
					v-model:time-zone="timeZone"
					v-model:month="month"
					v-model:selected="selected"
					:slots="page.slots"
					:loading="loadingTimes"
					:earliest="page.earliest"
					:latest="page.latest"
				/>
				<BookingGuestForm
					v-else-if="selected !== null"
					:start="selected"
					:duration-minutes="page.meetingType.durationMinutes"
					:time-zone="timeZone"
					:submitting="submitting"
					:error-key="formError"
					@submit="submit"
					@back="back"
				/>
			</section>
		</main>

		<RecipientFooter class="mt-auto" />
	</div>
</template>
