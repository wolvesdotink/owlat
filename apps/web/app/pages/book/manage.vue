<script setup lang="ts">
/**
 * A guest's own booking, opened from the link in their confirmation mail:
 * `/book/manage?token=…`. They can cancel it, or pick a new time from the
 * host's open times (their current slot counts as free). A reschedule mails a
 * fresh link and retires this one, so after it the page only confirms.
 */
import { getTzParts } from '@owlat/shared/ical';
import RecipientStateCard from '~/components/recipient/RecipientStateCard.vue';
import RecipientFooter from '~/components/recipient/RecipientFooter.vue';
import BookingSlotPicker from '~/components/booking/BookingSlotPicker.vue';
import {
	cancelManagedBooking,
	fetchManagedBooking,
	rescheduleManagedBooking,
	type ManagedBooking,
} from '~/lib/bookingClient';
import { useUrlCredential } from '~/composables/useUrlCredential';
import { browserTimeZone, formatSlotRange, monthWindow } from '~/utils/bookingSlots';
import { bookingErrorKey, isUnreachableReason } from '~/utils/bookingErrors';

definePageMeta({ layout: false });

const { t, locale } = useI18n();
useSeoMeta({ title: () => t('booking.manage.pageTitle'), robots: 'noindex' });

const { token } = useUrlCredential('token');

const timeZone = ref(browserTimeZone());
const today = getTzParts(Date.now(), timeZone.value);
const month = ref({ year: today.year, month: today.month });

const managed = ref<ManagedBooking | null>(null);
const reason = ref<string | null>(null);
const loadingTimes = ref(false);
const mode = ref<'view' | 'reschedule' | 'cancelled' | 'moved'>('view');
const selected = ref<number | null>(null);
const busy = ref(false);
const actionError = ref<string | null>(null);
const confirmCancel = ref(false);
const movedTo = ref<{ startAt: number; endAt: number } | null>(null);

let requestId = 0;
async function load() {
	if (!token.value) {
		reason.value = 'missing_token';
		return;
	}
	const id = ++requestId;
	loadingTimes.value = true;
	const result = await fetchManagedBooking(
		token.value,
		monthWindow(month.value.year, month.value.month, timeZone.value)
	);
	if (id !== requestId) return;
	loadingTimes.value = false;
	if (result.ok) managed.value = result.data;
	else if (!managed.value) reason.value = result.reason;
}

onMounted(load);
watch([month, timeZone], () => {
	if (mode.value === 'reschedule') void load();
});

const when = computed(() =>
	managed.value
		? formatSlotRange(
				managed.value.booking.startAt,
				managed.value.booking.endAt,
				locale.value,
				timeZone.value
			)
		: ''
);

function startReschedule() {
	mode.value = 'reschedule';
	actionError.value = null;
}

function stopReschedule() {
	mode.value = 'view';
	selected.value = null;
}

async function cancel() {
	if (!token.value) return;
	busy.value = true;
	actionError.value = null;
	const result = await cancelManagedBooking(token.value);
	busy.value = false;
	confirmCancel.value = false;
	if (result.ok) mode.value = 'cancelled';
	else actionError.value = bookingErrorKey(result.reason, 'booking.errors.cancelFailed');
}

async function reschedule() {
	if (!token.value || selected.value === null) return;
	busy.value = true;
	actionError.value = null;
	const result = await rescheduleManagedBooking(token.value, selected.value);
	busy.value = false;
	if (result.ok) {
		movedTo.value = result.data;
		mode.value = 'moved';
		return;
	}
	actionError.value = bookingErrorKey(result.reason, 'booking.errors.bookFailed');
	if (result.reason === 'slot_taken') {
		selected.value = null;
		await load();
	}
}
</script>

<template>
	<div
		class="flex min-h-dvh flex-col items-center gap-8 bg-bg-deep px-5 pt-[max(2.5rem,env(safe-area-inset-top))] pb-[max(2.5rem,env(safe-area-inset-bottom))] text-text-primary"
	>
		<div v-if="!managed" class="flex flex-1 items-center">
			<RecipientStateCard v-if="!reason" variant="loading" :message="t('booking.page.loading')" />
			<RecipientStateCard
				v-else
				variant="error"
				:heading="
					isUnreachableReason(reason)
						? t('booking.page.unreachableHeading')
						: t('booking.manage.notFoundHeading')
				"
				:message="t(bookingErrorKey(reason, 'booking.manage.notFoundBody'))"
			/>
		</div>

		<RecipientStateCard
			v-else-if="mode === 'cancelled'"
			variant="success"
			class="mt-[10vh]"
			:heading="t('booking.manage.cancelledHeading')"
			:message="t('booking.manage.cancelledBody', { host: managed.host.name })"
		/>

		<RecipientStateCard
			v-else-if="mode === 'moved' && movedTo"
			variant="success"
			class="mt-[10vh]"
			:heading="t('booking.manage.movedHeading')"
		>
			<p class="mb-2 text-text-primary">
				{{ formatSlotRange(movedTo.startAt, movedTo.endAt, locale, timeZone) }}
			</p>
			<p class="text-sm text-text-secondary">{{ t('booking.manage.movedBody') }}</p>
		</RecipientStateCard>

		<main v-else class="card w-full max-w-3xl space-y-6 p-6 md:p-8">
			<header>
				<p class="text-sm text-text-secondary">
					{{ t('booking.manage.withHost', { host: managed.host.name }) }}
				</p>
				<h1 class="font-display text-2xl break-words">{{ managed.booking.title }}</h1>
				<p class="mt-1 text-text-primary" data-testid="booking-manage-when">{{ when }}</p>
				<p
					v-if="managed.booking.status === 'cancelled'"
					class="mt-2 text-sm font-medium text-error"
				>
					{{ t('booking.manage.alreadyCancelled') }}
				</p>
				<p v-else-if="!managed.isChangeable" class="mt-2 text-sm text-text-tertiary">
					{{ t('booking.manage.notChangeable') }}
				</p>
			</header>

			<p v-if="actionError" class="text-sm text-error" role="alert">{{ t(actionError) }}</p>

			<div v-if="managed.isChangeable && mode === 'view'" class="flex flex-wrap gap-3">
				<UiButton v-if="managed.reschedule" @click="startReschedule">
					{{ t('booking.manage.reschedule') }}
				</UiButton>
				<UiButton variant="danger-outline" @click="confirmCancel = true">
					{{ t('booking.manage.cancel') }}
				</UiButton>
			</div>

			<section v-if="mode === 'reschedule' && managed.reschedule" class="space-y-4">
				<h2 class="text-lg font-semibold">{{ t('booking.manage.pickHeading') }}</h2>
				<BookingSlotPicker
					v-model:time-zone="timeZone"
					v-model:month="month"
					v-model:selected="selected"
					:slots="managed.reschedule.slots"
					:loading="loadingTimes"
					:earliest="managed.reschedule.earliest"
					:latest="managed.reschedule.latest"
				/>
				<div class="flex flex-wrap gap-3">
					<UiButton :disabled="selected === null" :loading="busy" @click="reschedule">
						{{
							selected === null
								? t('booking.manage.moveDisabled')
								: t('booking.manage.moveTo', {
										time: formatSlotRange(
											selected,
											selected + (managed.booking.endAt - managed.booking.startAt),
											locale,
											timeZone
										),
									})
						}}
					</UiButton>
					<UiButton variant="ghost" @click="stopReschedule">
						{{ t('common.cancel') }}
					</UiButton>
				</div>
			</section>
		</main>

		<UiConfirmationDialog
			:open="confirmCancel"
			:title="t('booking.manage.cancelConfirmTitle')"
			:description="t('booking.manage.cancelConfirmBody', { host: managed?.host.name ?? '' })"
			:confirm-text="t('booking.manage.cancel')"
			:cancel-text="t('booking.manage.keep')"
			variant="danger"
			:is-loading="busy"
			@update:open="confirmCancel = $event"
			@confirm="cancel"
		/>

		<RecipientFooter class="mt-auto" />
	</div>
</template>
