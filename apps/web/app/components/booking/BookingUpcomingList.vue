<script setup lang="ts">
/**
 * The host's upcoming bookings, soonest first: when, with whom, the guest's
 * note, and a cancel that tells the guest. Times are shown in the host's
 * browser zone.
 */
import { api } from '@owlat/api';
import type { Id } from '@owlat/api/dataModel';
import { browserTimeZone, formatSlotRange } from '~/utils/bookingSlots';

const { t, locale } = useI18n();

const { data, error, refetch } = useConvexQuery(api.booking.hostBookings.listUpcoming, {});
const zone = browserTimeZone();

const cancelling = ref<{ _id: Id<'bookings'>; guestName: string } | null>(null);
const cancel = useBackendOperation(api.booking.hostBookings.cancel, {
	label: () => t('components.booking.upcoming.cancelOperation'),
});

async function confirmCancel() {
	if (!cancelling.value) return;
	await cancel.run({ bookingId: cancelling.value._id });
	cancelling.value = null;
}
</script>

<template>
	<section class="card space-y-4 p-5" data-testid="booking-upcoming">
		<div>
			<h2 class="text-base font-semibold">{{ t('components.booking.upcoming.heading') }}</h2>
			<p class="text-sm text-text-secondary">
				{{ t('components.booking.upcoming.intro', { zone }) }}
			</p>
		</div>
		<UiQueryBoundary
			:loading="data === undefined"
			:error="error"
			:empty="(data ?? []).length === 0"
			@retry="refetch"
		>
			<template #loading>
				<div class="space-y-2" role="status" :aria-label="t('common.loading')">
					<UiSkeleton v-for="n in 3" :key="n" class="h-14 rounded-lg" />
				</div>
			</template>
			<template #empty>
				<UiEmptyState
					icon="lucide:calendar-days"
					:heading-level="3"
					:title="t('components.booking.upcoming.emptyTitle')"
					:description="t('components.booking.upcoming.emptyBody')"
				/>
			</template>
			<ul class="divide-y divide-border-subtle">
				<li
					v-for="booking in data ?? []"
					:key="booking._id"
					class="flex flex-wrap items-start justify-between gap-3 py-3"
				>
					<div class="min-w-0">
						<p class="font-medium">
							{{ formatSlotRange(booking.startAt, booking.endAt, locale, zone) }}
						</p>
						<p class="break-words text-sm text-text-secondary">
							{{
								t('components.booking.upcoming.with', {
									title: booking.title,
									guest: booking.guestName,
								})
							}}
							<a :href="`mailto:${booking.guestEmail}`" class="text-brand hover:underline">{{
								booking.guestEmail
							}}</a>
						</p>
						<p
							v-if="booking.guestNote"
							class="mt-1 whitespace-pre-line break-words text-sm text-text-tertiary"
						>
							{{ booking.guestNote }}
						</p>
					</div>
					<UiButton
						variant="ghost"
						size="sm"
						@click="cancelling = { _id: booking._id, guestName: booking.guestName }"
					>
						{{ t('components.booking.upcoming.cancel') }}
					</UiButton>
				</li>
			</ul>
		</UiQueryBoundary>
		<UiConfirmationDialog
			:open="cancelling !== null"
			variant="danger"
			:title="t('components.booking.upcoming.cancelTitle')"
			:description="
				t('components.booking.upcoming.cancelBody', { guest: cancelling?.guestName ?? '' })
			"
			:confirm-text="t('components.booking.upcoming.cancel')"
			:cancel-text="t('components.booking.upcoming.keep')"
			:is-loading="cancel.isLoading.value"
			@update:open="(open: boolean) => !open && (cancelling = null)"
			@confirm="confirmCancel"
		/>
	</section>
</template>
