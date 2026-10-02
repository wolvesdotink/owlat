<script setup lang="ts">
/**
 * The left column of a public booking page: who the meeting is with and what
 * it is — title, length, where, and the host's description. The video link
 * itself is not shown here; the confirmation mail carries it.
 */
import type { BookingHost, PublicMeetingType } from '~/lib/bookingClient';

const props = defineProps<{
	host: Pick<BookingHost, 'name' | 'image'>;
	meeting?: PublicMeetingType | null;
}>();

const { t } = useI18n();

const initial = computed(() => props.host.name.trim().charAt(0).toUpperCase() || '?');
</script>

<template>
	<aside class="min-w-0 space-y-4">
		<div class="flex items-center gap-3">
			<img
				v-if="host.image"
				:src="host.image"
				alt=""
				class="h-12 w-12 shrink-0 rounded-full object-cover"
			/>
			<span
				v-else
				class="flex h-12 w-12 shrink-0 items-center justify-center rounded-full bg-brand-subtle text-lg font-semibold text-brand"
				aria-hidden="true"
				>{{ initial }}</span
			>
			<p class="min-w-0 truncate font-medium text-text-secondary">{{ host.name }}</p>
		</div>
		<template v-if="meeting">
			<h1 class="font-display text-2xl break-words text-text-primary">{{ meeting.title }}</h1>
			<ul class="space-y-2 text-sm text-text-secondary">
				<li class="flex items-center gap-2">
					<Icon name="lucide:clock" class="h-4 w-4 shrink-0 text-text-tertiary" />
					{{ t('components.booking.summary.duration', { minutes: meeting.durationMinutes }) }}
				</li>
				<li v-if="meeting.location" class="flex items-start gap-2 break-words">
					<Icon name="lucide:map-pin" class="mt-0.5 h-4 w-4 shrink-0 text-text-tertiary" />
					<span class="min-w-0">{{ meeting.location }}</span>
				</li>
				<li v-if="meeting.hasVideoLink" class="flex items-center gap-2">
					<Icon name="lucide:video" class="h-4 w-4 shrink-0 text-text-tertiary" />
					{{ t('components.booking.summary.videoLink') }}
				</li>
			</ul>
			<p
				v-if="meeting.description"
				class="text-sm whitespace-pre-line break-words text-text-secondary"
			>
				{{ meeting.description }}
			</p>
		</template>
	</aside>
</template>
