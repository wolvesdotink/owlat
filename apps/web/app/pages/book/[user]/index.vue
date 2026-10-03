<script setup lang="ts">
/**
 * A host's booking page: `/book/<host>`. Lists the meetings they offer; each
 * opens its own page with the calendar.
 */
import RecipientStateCard from '~/components/recipient/RecipientStateCard.vue';
import RecipientFooter from '~/components/recipient/RecipientFooter.vue';
import BookingMeetingSummary from '~/components/booking/BookingMeetingSummary.vue';
import { fetchBookingPage, type BookingPageData } from '~/lib/bookingClient';
import { bookingErrorKey, isUnreachableReason } from '~/utils/bookingErrors';

definePageMeta({ layout: false });

const { t } = useI18n();
const route = useRoute();
const hostSlug = computed(() => String(route.params['user'] ?? ''));

const page = ref<BookingPageData | null>(null);
const reason = ref<string | null>(null);

useSeoMeta({
	title: () =>
		page.value
			? t('booking.host.seoTitle', { host: page.value.host.name })
			: t('booking.page.pageTitle'),
	robots: 'noindex',
});

onMounted(async () => {
	const result = await fetchBookingPage(hostSlug.value);
	if (result.ok) page.value = result.data;
	else reason.value = result.reason;
});
</script>

<template>
	<div
		class="flex min-h-dvh flex-col items-center gap-8 bg-bg-deep px-5 pt-[max(2.5rem,env(safe-area-inset-top))] pb-[max(2.5rem,env(safe-area-inset-bottom))] text-text-primary"
	>
		<div v-if="!page" class="flex flex-1 items-center">
			<RecipientStateCard v-if="!reason" variant="loading" :message="t('booking.page.loading')" />
			<RecipientStateCard
				v-else
				variant="error"
				:heading="
					isUnreachableReason(reason)
						? t('booking.page.unreachableHeading')
						: t('booking.page.notFoundHeading')
				"
				:message="t(bookingErrorKey(reason, 'booking.errors.notFound'))"
			/>
		</div>
		<main v-else class="card w-full max-w-xl space-y-6 p-6 md:p-8">
			<BookingMeetingSummary :host="page.host" />
			<h1 class="font-display text-2xl">
				{{ t('booking.host.heading', { host: page.host.name }) }}
			</h1>
			<p v-if="page.meetingTypes.length === 0" class="text-text-secondary">
				{{ t('booking.host.empty') }}
			</p>
			<ul v-else class="space-y-3">
				<li v-for="meeting in page.meetingTypes" :key="meeting.slug">
					<NuxtLink
						:to="`/book/${hostSlug}/${meeting.slug}`"
						class="flex items-center justify-between gap-4 rounded-lg border border-border-subtle p-4 transition-colors hover:border-brand"
					>
						<span class="min-w-0">
							<span class="block font-medium break-words text-text-primary">{{
								meeting.title
							}}</span>
							<span class="text-sm text-text-secondary">{{
								t('components.booking.summary.duration', { minutes: meeting.durationMinutes })
							}}</span>
						</span>
						<Icon name="lucide:chevron-right" class="h-5 w-5 shrink-0 text-text-tertiary" />
					</NuxtLink>
				</li>
			</ul>
		</main>
		<RecipientFooter class="mt-auto" />
	</div>
</template>
