<script setup lang="ts">
/**
 * The save state of a draft that saves itself (`useDraftAutosave`), shown in
 * place of a Save button: "Saved · 3s ago", "Saving…", offline with or
 * without a copy on this device, not kept on this device, saved with the
 * schedule still waiting for Schedule, or a failure with Retry. It renders the
 * session's status; it decides nothing about durability itself.
 *
 * Only the state is a live region: the age beside "Saved" keeps changing
 * while nothing happens, and a screen reader would read every change out.
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

const age = computed(() => {
	const savedAt = props.autosave.savedAt.value;
	if (status.value !== 'saved' || savedAt === null) return '';
	void now.value;
	return t('shared.draftAutosave.savedAge', { when: formatCompactRelativeTime(savedAt) });
});

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
		case 'unkept':
			return t('shared.draftAutosave.unkept');
		case 'scheduling':
			return t('shared.draftAutosave.scheduling');
		default:
			return t('shared.draftAutosave.saved');
	}
});

/** Why the last save failed, in the words the toast would have used. */
const errorDetail = computed(() => {
	if (status.value === 'unkept') return t('shared.draftAutosave.unkeptDetail');
	if (status.value === 'scheduling') return t('shared.draftAutosave.schedulingDetail');
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
		case 'unkept':
			return 'lucide:alert-circle';
		case 'editing':
			return 'lucide:pencil';
		case 'scheduling':
			return 'lucide:calendar-clock';
		default:
			return 'lucide:check';
	}
});
</script>

<template>
	<div class="flex shrink-0 items-center gap-2" data-testid="draft-save-status">
		<span
			class="inline-flex items-center gap-1.5 text-xs whitespace-nowrap"
			:class="
				status === 'error' || status === 'unkept'
					? 'text-error'
					: status === 'scheduling'
						? 'text-warning'
						: 'text-text-secondary'
			"
			:title="errorDetail || undefined"
		>
			<Icon
				:name="icon"
				class="w-3.5 h-3.5 shrink-0"
				:class="{ 'animate-spin motion-reduce:animate-none': status === 'saving' }"
				aria-hidden="true"
			/>
			<span>
				<span role="status">
					{{ label }}
					<span v-if="errorDetail" class="sr-only">{{ errorDetail }}</span>
				</span>
				<template v-if="age">{{ ` ${age}` }}</template>
			</span>
		</span>
		<UiButton
			v-if="status === 'error' && autosave.state.value.conflict === null"
			variant="ghost"
			size="sm"
			@click="autosave.retry()"
		>
			{{ t('shared.draftAutosave.retry') }}
		</UiButton>
	</div>
</template>
