<script setup lang="ts">
/**
 * Reply or Note, at the top of Answer mode's composer column. Reply is the
 * message the customer reads; Note is the team's internal note on the thread,
 * which nobody outside Owlat ever sees. The count says how many notes the
 * thread already has, so a teammate's context is not missed.
 */
type ComposeMode = 'reply' | 'note';

defineProps<{ noteCount: number }>();
const mode = defineModel<ComposeMode>({ required: true });

const { t } = useI18n();

const TABS: Array<{ id: ComposeMode; icon: string; label: string }> = [
	{ id: 'reply', icon: 'lucide:reply', label: 'components.inbox.notes.tabs.reply' },
	{ id: 'note', icon: 'lucide:sticky-note', label: 'components.inbox.notes.tabs.note' },
];
</script>

<template>
	<div
		role="tablist"
		:aria-label="t('components.inbox.notes.tabs.label')"
		class="flex shrink-0 items-center gap-1 border-b border-border-subtle px-3 py-1.5"
		data-testid="compose-mode-tabs"
	>
		<button
			v-for="tab in TABS"
			:key="tab.id"
			type="button"
			role="tab"
			:aria-selected="mode === tab.id"
			class="inline-flex items-center gap-1.5 rounded-md px-2.5 py-1 text-xs font-medium transition-colors duration-(--motion-fast) outline-none focus-visible:ring-1 focus-visible:ring-brand/50"
			:class="
				mode === tab.id
					? tab.id === 'note'
						? 'bg-warning/10 text-text-primary'
						: 'bg-bg-surface text-text-primary'
					: 'text-text-secondary hover:text-text-primary'
			"
			:data-testid="`compose-mode-${tab.id}`"
			@click="mode = tab.id"
		>
			<Icon :name="tab.icon" class="size-3.5" />
			{{ t(tab.label) }}
			<span
				v-if="tab.id === 'note' && noteCount > 0"
				class="tabular-nums text-text-tertiary"
				data-testid="compose-mode-note-count"
				>{{ noteCount }}</span
			>
		</button>
	</div>
</template>
