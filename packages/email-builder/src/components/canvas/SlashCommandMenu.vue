<script lang="ts">
import type { SlashCommand as Command } from '../../types';

/** Category display order; commands in any other category come last. */
const CATEGORY_ORDER = ['text', 'media', 'layout', 'components', 'brand', 'saved'] as const;

/**
 * The commands in the order the menu shows them: grouped by category, registry
 * order inside a group. The editor confirms the highlighted index against THIS
 * list, so the row Enter inserts is the row that is highlighted (the registry
 * order puts a component before some layout commands).
 */
/** One slash menu is open at a time (it follows the caret of the active editor). */
export const SLASH_MENU_ID = 'eb-slash-menu';

export function orderSlashCommands(commands: readonly Command[]): Command[] {
	const rank = (category: string) => {
		const index = (CATEGORY_ORDER as readonly string[]).indexOf(category);
		return index === -1 ? CATEGORY_ORDER.length : index;
	};
	return commands
		.map((command, index) => ({ command, index }))
		.sort((a, b) => rank(a.command.category) - rank(b.command.category) || a.index - b.index)
		.map(({ command }) => command);
}
</script>

<script setup lang="ts">
import { ref, watch, nextTick, computed } from 'vue';
import type { SlashCommand } from '../../types';
import { useBuilderI18n } from '../../i18n/useBuilderI18n';
import { slashCommandText } from '../../composables/useSlashCommands';

const i18n = useBuilderI18n();
const { t } = i18n;

const props = defineProps<{
	commands: SlashCommand[];
	selectedIndex: number;
	position: { top: number; left: number };
}>();

const emit = defineEmits<{
	(e: 'select', command: SlashCommand): void;
}>();

const listEl = ref<HTMLElement | null>(null);

/** The editor points aria-activedescendant at `${listId}-option-${index}`. */
const listId = SLASH_MENU_ID;

const categoryOrder = CATEGORY_ORDER;
const categoryLabelKeys: Record<string, string> = {
	text: 'builder.canvas.categories.text',
	media: 'builder.canvas.categories.media',
	layout: 'builder.canvas.categories.layout',
	components: 'builder.canvas.categories.components',
	brand: 'builder.canvas.categories.brand',
	saved: 'builder.canvas.categories.saved',
};

// Group commands by category
const groupedCommands = computed(() => {
	const groups: {
		category: string;
		label: string;
		commands: { command: SlashCommand; text: { name: string; description: string }; globalIndex: number }[];
	}[] = [];
	let globalIndex = 0;

	for (const cat of categoryOrder) {
		const cmds = props.commands.filter((c) => c.category === cat);
		if (cmds.length > 0) {
			groups.push({
				category: cat,
				label: categoryLabelKeys[cat] ? t(categoryLabelKeys[cat]) : cat,
				commands: cmds.map((cmd) => ({ command: cmd, text: slashCommandText(cmd, i18n), globalIndex: globalIndex++ })),
			});
		}
	}

	// Catch any commands in uncategorized categories
	const seen = new Set(categoryOrder as readonly string[]);
	const remaining = props.commands.filter((c) => !seen.has(c.category));
	if (remaining.length > 0) {
		groups.push({
			category: 'other',
			label: t('builder.canvas.categories.other'),
			commands: remaining.map((cmd) => ({ command: cmd, text: slashCommandText(cmd, i18n), globalIndex: globalIndex++ })),
		});
	}

	return groups;
});

// Auto-scroll selected item into view
watch(() => props.selectedIndex, () => {
	nextTick(() => {
		if (!listEl.value) return;
		const el = listEl.value.querySelector(`[data-index="${props.selectedIndex}"]`) as HTMLElement | null;
		el?.scrollIntoView({ block: 'nearest' });
	});
});
</script>

<template>
	<div
		:id="listId"
		role="listbox"
		:aria-label="t('builder.canvas.blockTypes')"
		class="absolute z-[100] w-60 max-h-[280px] overflow-y-auto bg-bg-elevated border border-border-subtle rounded-lg shadow-[0_4px_16px_rgba(0,0,0,0.25)] p-1"
		:style="{
			top: `${position.top}px`,
			left: `${position.left}px`,
		}"
	>
		<div v-if="commands.length === 0" class="p-3 text-caption text-text-tertiary text-center">
			{{ t('builder.canvas.noMatches') }}
		</div>
		<div v-else ref="listEl" class="flex flex-col">
			<template v-for="group in groupedCommands" :key="group.category">
				<div class="text-2xs font-semibold uppercase tracking-[0.04em] text-text-tertiary py-1.5 px-2 mt-0.5 first:mt-0">{{ group.label }}</div>
				<button
					v-for="{ command, text, globalIndex } in group.commands"
					:key="command.id"
					:id="`${listId}-option-${globalIndex}`"
					role="option"
					:aria-selected="globalIndex === selectedIndex"
					:data-index="globalIndex"
					class="flex items-center gap-2 py-1.5 px-2 border-none rounded-md bg-transparent cursor-pointer w-full text-left transition-[background-color,box-shadow] duration-(--motion-fast) hover:bg-bg-surface-hover"
					:class="globalIndex === selectedIndex && '!bg-brand/10 shadow-[inset_0_0_0_1px_color-mix(in_srgb,var(--color-brand)_25%,transparent)]'"
					@mousedown.prevent="emit('select', command)"
				>
					<component
						:is="command.icon"
						v-if="command.icon"
						class="shrink-0 w-4 h-4 transition-colors duration-(--motion-fast)"
						:class="globalIndex === selectedIndex ? 'text-brand' : 'text-text-secondary'"
						:size="16"
					/>
					<div v-else class="shrink-0 w-4 h-4 rounded-[3px]" :class="globalIndex === selectedIndex ? 'bg-brand/20' : 'bg-bg-surface'" />
					<div class="flex flex-col gap-px min-w-0">
						<span
							class="text-caption font-medium text-text-primary whitespace-nowrap overflow-hidden text-ellipsis"
							>{{ text.name }}</span
						>
						<span
							class="text-2xs text-text-tertiary whitespace-nowrap overflow-hidden text-ellipsis"
							>{{ text.description }}</span
						>
					</div>
				</button>
			</template>
		</div>
	</div>
</template>

