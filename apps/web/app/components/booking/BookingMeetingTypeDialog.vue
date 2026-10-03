<script setup lang="ts">
/**
 * Create or edit one meeting type: its title, link name, length, where it
 * happens (a place or a phone number, and/or a video link), what it is about,
 * and whether guests can book it right now.
 */
import { api } from '@owlat/api';
import type { Id } from '@owlat/api/dataModel';
import { BOOKING_LIMITS, isValidBookingSlug, suggestBookingSlug } from '@owlat/shared/booking';

export interface EditableMeetingType {
	_id: Id<'bookingMeetingTypes'>;
	slug: string;
	title: string;
	durationMinutes: number;
	description: string | null;
	location: string | null;
	videoUrl: string | null;
	isActive: boolean;
}

const props = defineProps<{
	open: boolean;
	meetingType: EditableMeetingType | null;
}>();

const emit = defineEmits<{ 'update:open': [value: boolean] }>();

const { t } = useI18n();

const DURATIONS = [15, 20, 30, 45, 60, 90] as const;

function seed() {
	const type = props.meetingType;
	return {
		title: type?.title ?? '',
		slug: type?.slug ?? '',
		durationMinutes: type?.durationMinutes ?? 30,
		location: type?.location ?? '',
		videoUrl: type?.videoUrl ?? '',
		description: type?.description ?? '',
		isActive: type?.isActive ?? true,
	};
}

const form = reactive(seed());
/** The link name follows the title until someone edits it by hand. */
const slugTouched = ref(false);

watch(
	() => [props.open, props.meetingType] as const,
	([open]) => {
		if (!open) return;
		Object.assign(form, seed());
		slugTouched.value = Boolean(props.meetingType);
		error.value = null;
	}
);

watch(
	() => form.title,
	(title) => {
		if (!slugTouched.value) form.slug = suggestBookingSlug(title);
	}
);

const error = ref<string | null>(null);
const save = useBackendOperation(api.booking.settings.saveMeetingType, {
	label: () => t('components.booking.meetingTypes.saveOperation'),
	inlineTarget: error,
});

const canSave = computed(
	() =>
		form.title.trim().length > 0 &&
		isValidBookingSlug(form.slug.trim()) &&
		form.durationMinutes >= BOOKING_LIMITS.durationMinMinutes &&
		form.durationMinutes <= BOOKING_LIMITS.durationMaxMinutes
);

async function submit() {
	if (!canSave.value) return;
	const result = await save.run({
		...(props.meetingType ? { meetingTypeId: props.meetingType._id } : {}),
		title: form.title.trim(),
		slug: form.slug.trim().toLowerCase(),
		durationMinutes: Math.round(Number(form.durationMinutes)),
		location: form.location.trim() || undefined,
		videoUrl: form.videoUrl.trim() || undefined,
		description: form.description.trim() || undefined,
		isActive: form.isActive,
	});
	if (result.ok) emit('update:open', false);
}
</script>

<template>
	<UiModal
		:open="open"
		:title="
			meetingType
				? t('components.booking.meetingTypes.editTitle')
				: t('components.booking.meetingTypes.newTitle')
		"
		size="lg"
		@update:open="emit('update:open', $event)"
	>
		<form id="booking-meeting-type-form" class="space-y-4" @submit.prevent="submit">
			<div>
				<label for="meeting-title" class="mb-1 block text-sm font-medium">
					{{ t('components.booking.meetingTypes.title') }}
				</label>
				<input
					id="meeting-title"
					v-model="form.title"
					type="text"
					class="input w-full"
					required
					:maxlength="BOOKING_LIMITS.titleMaxLength"
					:placeholder="t('components.booking.meetingTypes.titlePlaceholder')"
				/>
			</div>
			<div class="grid gap-4 sm:grid-cols-2">
				<div>
					<label for="meeting-slug" class="mb-1 block text-sm font-medium">
						{{ t('components.booking.meetingTypes.slug') }}
					</label>
					<input
						id="meeting-slug"
						v-model="form.slug"
						type="text"
						class="input w-full"
						autocapitalize="off"
						spellcheck="false"
						:maxlength="BOOKING_LIMITS.slugMaxLength"
						@input="slugTouched = true"
					/>
				</div>
				<div>
					<label for="meeting-duration" class="mb-1 block text-sm font-medium">
						{{ t('components.booking.meetingTypes.duration') }}
					</label>
					<select id="meeting-duration" v-model.number="form.durationMinutes" class="input w-full">
						<option v-for="minutes in DURATIONS" :key="minutes" :value="minutes">
							{{ t('components.booking.summary.duration', { minutes }) }}
						</option>
						<option
							v-if="!(DURATIONS as readonly number[]).includes(form.durationMinutes)"
							:value="form.durationMinutes"
						>
							{{ t('components.booking.summary.duration', { minutes: form.durationMinutes }) }}
						</option>
					</select>
				</div>
			</div>
			<div>
				<label for="meeting-location" class="mb-1 block text-sm font-medium">
					{{ t('components.booking.meetingTypes.location') }}
				</label>
				<input
					id="meeting-location"
					v-model="form.location"
					type="text"
					class="input w-full"
					:maxlength="BOOKING_LIMITS.locationMaxLength"
					:placeholder="t('components.booking.meetingTypes.locationPlaceholder')"
				/>
			</div>
			<div>
				<label for="meeting-video" class="mb-1 block text-sm font-medium">
					{{ t('components.booking.meetingTypes.videoUrl') }}
				</label>
				<input
					id="meeting-video"
					v-model="form.videoUrl"
					type="url"
					class="input w-full"
					:maxlength="BOOKING_LIMITS.videoUrlMaxLength"
					placeholder="https://"
				/>
				<p class="mt-1 text-xs text-text-tertiary">
					{{ t('components.booking.meetingTypes.videoUrlHint') }}
				</p>
			</div>
			<div>
				<label for="meeting-description" class="mb-1 block text-sm font-medium">
					{{ t('components.booking.meetingTypes.description') }}
				</label>
				<textarea
					id="meeting-description"
					v-model="form.description"
					rows="3"
					class="input w-full font-sans"
					:maxlength="BOOKING_LIMITS.descriptionMaxLength"
				/>
			</div>
			<label class="flex items-center justify-between gap-4">
				<span class="text-sm font-medium">{{ t('components.booking.meetingTypes.active') }}</span>
				<UiSwitch v-model="form.isActive" />
			</label>
			<p v-if="error" class="text-sm text-error" role="alert">{{ error }}</p>
		</form>
		<template #footer>
			<UiButton variant="ghost" @click="emit('update:open', false)">{{
				t('common.cancel')
			}}</UiButton>
			<UiButton
				type="submit"
				form="booking-meeting-type-form"
				:disabled="!canSave"
				:loading="save.isLoading.value"
			>
				{{ t('common.save') }}
			</UiButton>
		</template>
	</UiModal>
</template>
