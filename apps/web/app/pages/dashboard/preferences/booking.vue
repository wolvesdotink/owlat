<script setup lang="ts">
/**
 * My settings → Booking page. A personal page where people pick a time to
 * meet: the page's link and hours, the meetings it offers, and the bookings
 * made on it. The meeting types and bookings appear once the page exists.
 */
import { api } from '@owlat/api';
import BookingProfileForm from '~/components/booking/BookingProfileForm.vue';
import BookingMeetingTypes from '~/components/booking/BookingMeetingTypes.vue';
import BookingUpcomingList from '~/components/booking/BookingUpcomingList.vue';

const { t } = useI18n();

useHead({ title: () => t('dashboard.preferences.booking.pageTitle') });

definePageMeta({
	layout: 'preferences',
	middleware: 'auth',
	requiresFeature: 'calendar.booking',
});

const { data, error, refetch } = useConvexQuery(api.booking.settings.getMine, {});

const { copy, isCopied } = useCopyToClipboard();
</script>

<template>
	<div class="space-y-6">
		<header class="space-y-3">
			<p class="text-text-secondary">{{ t('dashboard.preferences.booking.intro') }}</p>
			<div
				v-if="data?.profile"
				class="flex flex-wrap items-center gap-2 rounded-lg border border-border-subtle bg-bg-surface px-3 py-2"
				data-testid="booking-page-link"
			>
				<Icon name="lucide:link" class="h-4 w-4 shrink-0 text-text-tertiary" />
				<a
					:href="data.profile.pageUrl"
					target="_blank"
					rel="noopener"
					class="min-w-0 flex-1 truncate text-sm text-brand hover:underline"
					>{{ data.profile.pageUrl }}</a
				>
				<UiButton variant="ghost" size="sm" @click="copy(data.profile.pageUrl, 'page')">
					<Icon :name="isCopied('page') ? 'lucide:check' : 'lucide:copy'" class="mr-1 h-4 w-4" />
					{{
						isCopied('page')
							? t('dashboard.preferences.booking.copied')
							: t('dashboard.preferences.booking.copyLink')
					}}
				</UiButton>
			</div>
		</header>

		<UiQueryBoundary :loading="data === undefined" :error="error" @retry="refetch">
			<template #loading>
				<div
					class="card space-y-4 p-5"
					role="status"
					aria-busy="true"
					:aria-label="t('common.loading')"
				>
					<UiSkeleton class="h-6 w-48" />
					<UiSkeleton class="h-10 rounded-lg" />
					<UiSkeleton class="h-40 rounded-lg" />
				</div>
			</template>
			<div v-if="data" class="space-y-6">
				<BookingUpcomingList v-if="data.profile" />
				<BookingMeetingTypes v-if="data.profile" :meeting-types="data.meetingTypes" />
				<BookingProfileForm
					:profile="data.profile"
					:suggested-slug="data.suggestedSlug"
					:site-origin="data.siteUrl"
				/>
			</div>
		</UiQueryBoundary>
	</div>
</template>
