<script setup lang="ts">
/**
 * A device copy of unsaved edits another editor of this draft left behind
 * (`useDraftAutosave`'s recovery). It is never put into the editor on its own:
 * the person chooses to restore those edits over the current draft, or to let
 * them go. When the draft was edited after the notice appeared, Restore asks
 * once more, since it would replace those edits.
 */
import { formatDateTime } from '~/utils/formatters';

defineProps<{
	/** When the copy was written. */
	savedAt: number;
	/** The draft was edited since: the next Restore replaces that work. */
	confirm?: boolean;
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
				{{
					t(
						confirm
							? 'shared.draftAutosave.recovery.confirm'
							: 'shared.draftAutosave.recovery.description',
						{ when: formatDateTime(savedAt) }
					)
				}}
			</p>
		</div>
		<div class="flex shrink-0 items-center gap-2">
			<UiButton variant="ghost" size="sm" @click="emit('discard')">
				{{ t('shared.draftAutosave.recovery.discard') }}
			</UiButton>
			<UiButton variant="secondary" size="sm" @click="emit('restore')">
				{{
					confirm
						? t('shared.draftAutosave.recovery.restoreAnyway')
						: t('shared.draftAutosave.recovery.restore')
				}}
			</UiButton>
		</div>
	</div>
</template>
