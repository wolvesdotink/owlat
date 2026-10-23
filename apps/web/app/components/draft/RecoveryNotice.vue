<script setup lang="ts">
/**
 * A device copy of unsaved edits (`useDraftRecovery`) that was not applied on
 * its own, because what the server holds changed after it was written. The
 * person chooses: put those edits back over the current state, or let them go.
 */
import { formatDateTime } from '~/utils/formatters';

defineProps<{
	/** When the copy was written. */
	savedAt: number;
}>();

const emit = defineEmits<{ restore: []; discard: [] }>();

const { t } = useI18n();
</script>

<template>
	<div
		class="shrink-0 flex flex-wrap items-center justify-between gap-3 border-b border-warning/20 bg-warning/10 px-4 py-2"
		role="region"
		:aria-label="t('shared.draftAutosave.recovery.title')"
		data-testid="draft-recovery-notice"
	>
		<div class="flex min-w-0 items-start gap-2">
			<Icon name="lucide:history" class="w-4 h-4 mt-0.5 shrink-0 text-warning" aria-hidden="true" />
			<p class="min-w-0 text-sm text-text-primary">
				<span class="font-medium">{{ t('shared.draftAutosave.recovery.title') }}</span>
				{{ t('shared.draftAutosave.recovery.description', { when: formatDateTime(savedAt) }) }}
			</p>
		</div>
		<div class="flex shrink-0 items-center gap-2">
			<UiButton variant="ghost" size="sm" @click="emit('discard')">
				{{ t('shared.draftAutosave.recovery.discard') }}
			</UiButton>
			<UiButton variant="secondary" size="sm" @click="emit('restore')">
				{{ t('shared.draftAutosave.recovery.restore') }}
			</UiButton>
		</div>
	</div>
</template>
