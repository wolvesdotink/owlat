<script setup lang="ts">
import {
	threadStatusChip,
	threadChipDotClass,
	type ThreadChipInput,
} from '~/utils/threadStatusChip';

/**
 * The single status chip for a conversation thread — one dot + one human label,
 * rolled up from the thread's status / draft / snooze signals via the shared
 * `threadStatusChip` vocabulary. Used everywhere a thread's status is shown so
 * the language never forks.
 *
 * A recently-returned snooze (`snoozeReturnedAt`) shows a quiet "· Returned"
 * suffix so a resurfaced thread reads differently from a never-snoozed one,
 * without adding a second chip.
 */
const props = defineProps<{
	status: ThreadChipInput['status'];
	latestDraftStatus?: ThreadChipInput['latestDraftStatus'];
	snoozedUntil?: number | null;
	/** Set when the wake cron (or an inbound reply) just resurfaced the thread. */
	snoozeReturnedAt?: number | null;
}>();

const { t } = useI18n();

const chip = computed(() =>
	threadStatusChip({
		status: props.status,
		latestDraftStatus: props.latestDraftStatus,
		snoozedUntil: props.snoozedUntil,
	})
);

const dotClass = computed(() => threadChipDotClass(chip.value.variant));

// Only surface the "returned" marker while the thread is not currently snoozed
// (a fresh snooze supersedes a stale marker). The chip's label is an i18n key,
// so the snoozed state is read off the `info` variant the snooze branch carries.
const showReturned = computed(
	() => props.snoozeReturnedAt != null && chip.value.variant !== 'info'
);
</script>

<template>
	<span class="inline-flex items-center gap-1.5 text-xs text-text-secondary">
		<span class="w-1.5 h-1.5 rounded-full" :class="dotClass" aria-hidden="true" />
		<!-- The status vocabulary holds i18n keys, not copy (see the localization guide). -->
		<span>{{ t(chip.label) }}</span>
		<span v-if="showReturned" class="text-text-tertiary">
			{{ t('components.inbox.statusChip.returned') }}
		</span>
	</span>
</template>
