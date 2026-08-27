<script setup lang="ts">
/**
 * The strip a SCHEDULED draft wears in the composer: when it goes out, and the
 * one control that takes it back.
 *
 * A scheduled row is read-only — `drafts.update` rejects it, so autosave is
 * suppressed and the editor is gated behind an explicit unschedule (mirroring
 * campaigns' Unschedule-to-Edit). Unscheduling reverts the row to `draft`,
 * which re-enables both. Failures are already toasted by the mutation's
 * operation wrapper, so this only owns the in-flight state.
 *
 * Renders nothing for an unscheduled draft; extracted from PostboxComposer.vue
 * to keep that surface focused (and under the file-size cap).
 */
const props = defineProps<{
	/** The draft's lifecycle state is 'scheduled' — otherwise nothing renders. */
	isScheduled: boolean;
	/** When it is due to go out, epoch-ms; absent while the row is hydrating. */
	scheduledSendAt: number | null;
	/** Reverts the row to 'draft'. Resolves false when the revert did not land. */
	cancelSchedule: () => Promise<boolean>;
}>();

const { t } = useI18n();

const unscheduling = ref(false);
async function handleUnschedule() {
	if (unscheduling.value) return;
	unscheduling.value = true;
	try {
		await props.cancelSchedule();
	} finally {
		unscheduling.value = false;
	}
}

const scheduledLabel = computed(() =>
	props.scheduledSendAt ? formatDateTime(props.scheduledSendAt) : ''
);
</script>

<template>
	<div
		v-if="isScheduled"
		class="flex items-center justify-between gap-3 px-3 py-2 border-b border-border-subtle bg-bg-surface text-sm"
	>
		<span class="inline-flex items-center gap-1.5 text-text-secondary">
			<Icon name="lucide:clock" class="w-4 h-4 text-brand" />
			{{ t('components.postbox.postboxComposer.scheduledFor', { datetime: scheduledLabel }) }}
		</span>
		<UiButton
			variant="ghost"
			type="button"
			class="text-xs"
			:disabled="unscheduling"
			@click="handleUnschedule"
		>
			<Icon v-if="unscheduling" name="lucide:loader-2" class="w-3.5 h-3.5 mr-1 animate-spin" />
			{{ t('components.postbox.postboxComposer.unschedule') }}
		</UiButton>
	</div>
</template>
