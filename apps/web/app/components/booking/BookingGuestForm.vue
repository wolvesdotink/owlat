<script setup lang="ts">
/**
 * The guest's details for a chosen time: name, email and an optional note,
 * plus a honeypot field no person sees (a form-filling bot fills it and the
 * server quietly books nothing). Emits the details; the page owns the request.
 */
import { BOOKING_LIMITS } from '@owlat/shared/booking';
import { formatSlotRange } from '~/utils/bookingSlots';

const props = defineProps<{
	start: number;
	durationMinutes: number;
	timeZone: string;
	submitting?: boolean;
	/** An i18n key for the last refusal, shown above the button. */
	errorKey?: string | null;
}>();

const emit = defineEmits<{
	submit: [details: { name: string; email: string; note: string; website: string }];
	back: [];
}>();

const { t, locale } = useI18n();

const form = reactive({ name: '', email: '', note: '', website: '' });

const when = computed(() =>
	formatSlotRange(
		props.start,
		props.start + props.durationMinutes * 60_000,
		locale.value,
		props.timeZone
	)
);

function onSubmit() {
	emit('submit', { ...form });
}
</script>

<template>
	<form class="space-y-4" data-testid="booking-guest-form" @submit.prevent="onSubmit">
		<div class="flex items-center justify-between gap-3 rounded-lg bg-bg-surface px-3 py-2">
			<p class="text-sm text-text-primary">
				<Icon
					name="lucide:calendar-clock"
					class="mr-1.5 inline h-4 w-4 align-text-bottom text-brand"
				/>
				{{ when }}
			</p>
			<UiButton variant="ghost" size="sm" @click="emit('back')">
				{{ t('components.booking.guestForm.change') }}
			</UiButton>
		</div>
		<div>
			<label for="booking-guest-name" class="mb-1 block text-sm font-medium">
				{{ t('components.booking.guestForm.name') }}
			</label>
			<input
				id="booking-guest-name"
				v-model="form.name"
				type="text"
				class="input w-full"
				autocomplete="name"
				required
				:maxlength="BOOKING_LIMITS.guestNameMaxLength"
			/>
		</div>
		<div>
			<label for="booking-guest-email" class="mb-1 block text-sm font-medium">
				{{ t('components.booking.guestForm.email') }}
			</label>
			<input
				id="booking-guest-email"
				v-model="form.email"
				type="email"
				class="input w-full"
				autocomplete="email"
				required
				maxlength="254"
			/>
		</div>
		<div>
			<label for="booking-guest-note" class="mb-1 block text-sm font-medium">
				{{ t('components.booking.guestForm.note') }}
			</label>
			<textarea
				id="booking-guest-note"
				v-model="form.note"
				rows="3"
				class="input w-full font-sans"
				:maxlength="BOOKING_LIMITS.guestNoteMaxLength"
				:placeholder="t('common.optional')"
			/>
		</div>
		<!-- Honeypot: off-screen and out of the tab order and the accessibility tree. -->
		<div class="absolute -left-[9999px] h-px w-px overflow-hidden" aria-hidden="true">
			<label for="booking-guest-website">{{ t('components.booking.guestForm.honeypot') }}</label>
			<input
				id="booking-guest-website"
				v-model="form.website"
				type="text"
				tabindex="-1"
				autocomplete="off"
			/>
		</div>
		<p v-if="errorKey" class="text-sm text-error" role="alert">{{ t(errorKey) }}</p>
		<UiButton type="submit" full-width :loading="submitting" data-testid="booking-confirm">
			{{ t('components.booking.guestForm.confirm') }}
		</UiButton>
	</form>
</template>
