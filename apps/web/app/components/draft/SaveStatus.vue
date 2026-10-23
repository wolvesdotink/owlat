<script setup lang="ts">
/**
 * The save state of a draft that saves itself (`useDraftAutosave`), where a
 * Save button used to be: "Saved · 3s ago", "Saving…", offline with or
 * without a copy on this device, or a failure with Retry.
 */
import type { DraftAutosave } from '~/composables/useDraftAutosave';
import { SaveRefusedError } from '~/composables/useEditorSaveOperation';
import { operationCopy, operationToastCopy, resolveOperationCopy } from '~/lib/operationError';
import { formatCompactRelativeTime } from '~/utils/formatters';

const props = defineProps<{ autosave: DraftAutosave }>();

const status = computed(() => props.autosave.status.value);

const { t, locale, te } = useI18n();
// Re-renders "3s ago" as it ages; the formatter reads the clock itself.
const now = useNow({ intervalMs: 5_000 });

const label = computed(() => {
	switch (status.value) {
		case 'editing':
			return t('shared.draftAutosave.editing');
		case 'saving':
			return t('shared.draftAutosave.saving');
		case 'offline':
			return props.autosave.onDevice.value
				? t('shared.draftAutosave.offlineOnDevice')
				: t('shared.draftAutosave.offlineNotSaved');
		case 'error':
			return t('shared.draftAutosave.notSaved');
		case 'saved':
			void now.value;
			return t('shared.draftAutosave.savedAgo', {
				when: formatCompactRelativeTime(props.autosave.savedAt.value),
			});
		default:
			return t('shared.draftAutosave.saved');
	}
});

/** Why the last save failed, in the words the toast would have used. */
const errorDetail = computed(() => {
	if (status.value !== 'error') return '';
	const error = props.autosave.error.value;
	const options = { locale: locale.value, hasMessage: (key: string) => te(key) };
	const copy =
		error instanceof SaveRefusedError
			? operationCopy(error.op, options)
			: operationToastCopy(error, 'shared.draftAutosave.failed', options);
	return resolveOperationCopy(copy, t);
});

const icon = computed(() => {
	switch (status.value) {
		case 'saving':
			return 'lucide:loader-2';
		case 'offline':
			return 'lucide:cloud-off';
		case 'error':
			return 'lucide:alert-circle';
		case 'editing':
			return 'lucide:pencil';
		default:
			return 'lucide:check';
	}
});
</script>

<template>
	<div class="flex shrink-0 items-center gap-2" data-testid="draft-save-status">
		<span
			role="status"
			class="inline-flex items-center gap-1.5 text-xs whitespace-nowrap"
			:class="status === 'error' ? 'text-error' : 'text-text-secondary'"
			:title="errorDetail || undefined"
		>
			<Icon
				:name="icon"
				class="w-3.5 h-3.5 shrink-0"
				:class="{ 'animate-spin motion-reduce:animate-none': status === 'saving' }"
				aria-hidden="true"
			/>
			{{ label }}
			<span v-if="errorDetail" class="sr-only">{{ errorDetail }}</span>
		</span>
		<UiButton v-if="status === 'error'" variant="ghost" size="sm" @click="autosave.retry()">
			{{ t('shared.draftAutosave.retry') }}
		</UiButton>
	</div>
</template>
