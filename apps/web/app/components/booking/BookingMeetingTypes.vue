<script setup lang="ts">
/**
 * The meetings a booking page offers: each with its public link (copyable),
 * its length and whether it is bookable right now; add, edit and delete.
 * Deleting a meeting type leaves bookings already made untouched.
 */
import { api } from '@owlat/api';
import BookingMeetingTypeDialog, {
	type EditableMeetingType,
} from '~/components/booking/BookingMeetingTypeDialog.vue';
import { BOOKING_LIMITS } from '@owlat/shared/booking';

defineProps<{
	meetingTypes: (EditableMeetingType & { url: string | null })[];
}>();

const { t } = useI18n();
const { copy, isCopied } = useCopyToClipboard();

const dialogOpen = ref(false);
const editing = ref<EditableMeetingType | null>(null);
const deleting = ref<EditableMeetingType | null>(null);

const remove = useBackendOperation(api.booking.settings.deleteMeetingType, {
	label: () => t('components.booking.meetingTypes.deleteOperation'),
});

function openNew() {
	editing.value = null;
	dialogOpen.value = true;
}

function openEdit(type: EditableMeetingType) {
	editing.value = type;
	dialogOpen.value = true;
}

async function confirmDelete() {
	if (!deleting.value) return;
	await remove.run({ meetingTypeId: deleting.value._id });
	deleting.value = null;
}
</script>

<template>
	<section class="card space-y-4 p-5" data-testid="booking-meeting-types">
		<div class="flex flex-wrap items-start justify-between gap-3">
			<div>
				<h2 class="text-base font-semibold">{{ t('components.booking.meetingTypes.heading') }}</h2>
				<p class="text-sm text-text-secondary">{{ t('components.booking.meetingTypes.intro') }}</p>
			</div>
			<UiButton
				variant="secondary"
				:disabled="meetingTypes.length >= BOOKING_LIMITS.meetingTypesMax"
				@click="openNew"
			>
				<Icon name="lucide:plus" class="mr-1 h-4 w-4" />
				{{ t('components.booking.meetingTypes.add') }}
			</UiButton>
		</div>

		<UiEmptyState
			v-if="meetingTypes.length === 0"
			icon="lucide:calendar-plus"
			:heading-level="3"
			:title="t('components.booking.meetingTypes.emptyTitle')"
			:description="t('components.booking.meetingTypes.emptyBody')"
		/>

		<ul v-else class="divide-y divide-border-subtle">
			<li
				v-for="type in meetingTypes"
				:key="type._id"
				class="flex flex-wrap items-center justify-between gap-3 py-3"
			>
				<div class="min-w-0">
					<p class="flex items-center gap-2 font-medium">
						<span class="truncate">{{ type.title }}</span>
						<UiBadge v-if="!type.isActive" variant="neutral">{{
							t('components.booking.meetingTypes.inactive')
						}}</UiBadge>
					</p>
					<p class="truncate text-sm text-text-tertiary">
						{{ t('components.booking.summary.duration', { minutes: type.durationMinutes }) }}
						<template v-if="type.url"> · {{ type.url }}</template>
					</p>
				</div>
				<div class="flex shrink-0 items-center gap-1">
					<UiButton
						v-if="type.url"
						variant="ghost"
						size="sm"
						:aria-label="t('components.booking.meetingTypes.copyLink', { title: type.title })"
						@click="copy(type.url, type._id)"
					>
						<Icon :name="isCopied(type._id) ? 'lucide:check' : 'lucide:link'" class="h-4 w-4" />
					</UiButton>
					<UiButton
						variant="ghost"
						size="sm"
						:aria-label="t('components.booking.meetingTypes.edit', { title: type.title })"
						@click="openEdit(type)"
					>
						<Icon name="lucide:pencil" class="h-4 w-4" />
					</UiButton>
					<UiButton
						variant="ghost"
						size="sm"
						:aria-label="t('components.booking.meetingTypes.delete', { title: type.title })"
						@click="deleting = type"
					>
						<Icon name="lucide:trash-2" class="h-4 w-4" />
					</UiButton>
				</div>
			</li>
		</ul>

		<BookingMeetingTypeDialog v-model:open="dialogOpen" :meeting-type="editing" />
		<UiConfirmationDialog
			:open="deleting !== null"
			variant="danger"
			:title="t('components.booking.meetingTypes.deleteTitle')"
			:description="
				t('components.booking.meetingTypes.deleteBody', { title: deleting?.title ?? '' })
			"
			:confirm-text="t('common.delete')"
			:is-loading="remove.isLoading.value"
			@update:open="(open: boolean) => !open && (deleting = null)"
			@confirm="confirmDelete"
		/>
	</section>
</template>
