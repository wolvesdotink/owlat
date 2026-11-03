<script setup lang="ts">
/**
 * The Team inbox reply's own items in the composer footer's ⋯ menu: the edit
 * diff, saving and restoring the working draft, writing one's own reply, and
 * discarding (an agent draft) or clearing (one's own text). Split out of
 * {@link ThreadComposer} to keep it under the file-size ratchet; it only
 * renders and reports, the composer owns the state.
 */
import {
	EraserIcon,
	GitCompareIcon,
	PencilIcon,
	SaveIcon,
	TrashIcon,
	UndoIcon,
} from '@coolicons/vue';

defineProps<{
	/** The footer menu's `close`, run before every item's action. */
	close: () => void;
	hasChanges: boolean;
	diffOpen: boolean;
	edited: boolean;
	hasDraft: boolean;
	busy: boolean;
	/** The box holds more than whitespace (Save needs that). */
	hasText: boolean;
	/** The box is not empty (Clear needs that). */
	canClear: boolean;
}>();

const emit = defineEmits<{
	(e: 'toggle-diff'): void;
	(e: 'save'): void;
	(e: 'restore'): void;
	(e: 'write-own'): void;
	(e: 'reject'): void;
}>();

const { t } = useI18n();

const menuItem =
	'flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm hover:bg-bg-surface disabled:opacity-50';
</script>

<template>
	<button
		v-if="hasChanges"
		type="button"
		role="menuitem"
		:class="menuItem"
		data-testid="thread-composer-show-changes"
		@click="(close(), emit('toggle-diff'))"
	>
		<GitCompareIcon class="size-4 text-text-tertiary" />
		{{
			diffOpen ? t('components.answer.team.hideChanges') : t('components.answer.team.showChanges')
		}}
	</button>
	<button
		v-if="edited"
		type="button"
		role="menuitem"
		:class="menuItem"
		:disabled="busy || !hasText"
		data-testid="thread-composer-save"
		@click="(close(), emit('save'))"
	>
		<SaveIcon class="size-4 text-text-tertiary" />
		{{ t('dashboard.inbox.detail.composer.saveDraft') }}
	</button>
	<button
		v-if="edited"
		type="button"
		role="menuitem"
		:class="menuItem"
		:disabled="busy"
		data-testid="thread-composer-restore"
		@click="(close(), emit('restore'))"
	>
		<UndoIcon class="size-4 text-text-tertiary" />
		{{ t('dashboard.inbox.detail.composer.restoreDraft') }}
	</button>
	<button
		v-if="hasDraft"
		type="button"
		role="menuitem"
		:class="menuItem"
		:disabled="busy"
		data-testid="thread-composer-write-own"
		@click="(close(), emit('write-own'))"
	>
		<PencilIcon class="size-4 text-text-tertiary" />
		{{ t('dashboard.inbox.detail.composer.writeOwn') }}
	</button>
	<button
		v-if="hasDraft"
		type="button"
		role="menuitem"
		:class="[menuItem, 'text-error']"
		:disabled="busy"
		data-testid="thread-composer-skip"
		@click="(close(), emit('reject'))"
	>
		<TrashIcon class="size-4" />
		{{ t('components.answer.team.discardDraft') }}
	</button>
	<button
		v-else
		type="button"
		role="menuitem"
		:class="menuItem"
		:disabled="busy || !canClear"
		data-testid="thread-composer-clear"
		@click="(close(), emit('write-own'))"
	>
		<EraserIcon class="size-4 text-text-tertiary" />
		{{ t('components.answer.team.clear') }}
	</button>
</template>
