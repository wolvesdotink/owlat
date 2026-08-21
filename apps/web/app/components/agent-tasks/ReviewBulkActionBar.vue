<script setup lang="ts">
/**
 * Sticky bulk-actions bar for the Review Queue browse list (piece C2) —
 * the review twin of PostboxQuickActionsBar: floats above the listbox while
 * one or more cards are selected, hidden otherwise. Presentational: the
 * browse list owns the selection Set and the batch mutations, and the server
 * answers per id (a selected draftless escalation simply comes back as
 * `no_draft` in the shared toast rather than being pre-filtered here).
 */
defineProps<{
	/** Selected cards. The bar is hidden at 0. */
	count: number;
	/** Visible rows not yet selected — hides "Select all" once exhausted. */
	remaining: number;
	/** A batch mutation is in flight — hold both action buttons. */
	busy: boolean;
}>();

const emit = defineEmits<{
	(e: 'approve' | 'reject' | 'select-all' | 'clear'): void;
}>();

const { t } = useI18n();
</script>

<template>
	<Transition
		enter-active-class="transition-all duration-(--motion-moderate)"
		enter-from-class="-translate-y-full opacity-0"
		enter-to-class="translate-y-0 opacity-100"
		leave-active-class="transition-all duration-(--motion-moderate-exit)"
		leave-from-class="translate-y-0 opacity-100"
		leave-to-class="-translate-y-full opacity-0"
	>
		<div
			v-if="count > 0"
			class="sticky top-0 z-10 bg-bg-elevated border border-border-subtle rounded-lg px-3 py-2 mb-4 flex items-center gap-2 text-sm shadow-sm"
		>
			<span class="font-medium">{{
				t('components.agentTasks.reviewBulkActionBar.selected', { count })
			}}</span>
			<button
				v-if="remaining > 0"
				type="button"
				class="text-brand hover:underline"
				@click="emit('select-all')"
			>
				{{ t('components.agentTasks.reviewBulkActionBar.selectAll') }}
			</button>
			<span class="flex-1" />
			<UiButton
				variant="ghost"
				size="sm"
				class="gap-1.5 px-2 py-1"
				:disabled="busy"
				@click="emit('approve')"
			>
				<template #iconLeft>
					<Icon name="lucide:check" class="w-4 h-4" />
				</template>
				{{ t('components.agentTasks.reviewBulkActionBar.approveCount', { count }) }}
			</UiButton>
			<UiButton
				variant="danger-ghost"
				size="sm"
				class="gap-1.5 px-2 py-1"
				:disabled="busy"
				@click="emit('reject')"
			>
				<template #iconLeft>
					<Icon name="lucide:x-circle" class="w-4 h-4" />
				</template>
				{{ t('components.agentTasks.reviewBulkActionBar.rejectCount', { count }) }}
			</UiButton>
			<span class="w-px h-4 bg-border-subtle mx-1" />
			<button
				type="button"
				class="p-1 rounded hover:bg-bg-surface-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand"
				:title="t('components.postbox.postboxQuickActionsBar.clearSelectionTitle')"
				:aria-label="t('components.postbox.postboxQuickActionsBar.clearSelectionTitle')"
				@click="emit('clear')"
			>
				<Icon name="lucide:x" class="w-4 h-4" />
			</button>
		</div>
	</Transition>
</template>
