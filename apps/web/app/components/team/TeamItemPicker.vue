<script setup lang="ts">
/**
 * The `#` picker of the team composer: a listbox of the thread's open actions.
 * The composer keeps focus and drives it (ArrowUp / ArrowDown move the active
 * option, Enter or Tab picks it, Escape closes); a click picks too. The active
 * option is named by the textarea's `aria-activedescendant`.
 */
import type { BriefItemView } from '../../../../api/convex/mail/interpret/briefShape';

const props = defineProps<{
	items: readonly BriefItemView[];
	activeIndex: number;
	/** The listbox id; option ids are `<listId>-<index>`. */
	listId: string;
}>();

const emit = defineEmits<{ pick: [item: BriefItemView]; hover: [index: number] }>();

const { t } = useI18n();
const root = ref<HTMLElement | null>(null);

// Keep the active option in view as the arrows move it.
watch(
	() => props.activeIndex,
	(index) =>
		void nextTick(() =>
			root.value?.querySelector(`#${CSS.escape(`${props.listId}-${index}`)}`)?.scrollIntoView?.({
				block: 'nearest',
			})
		)
);

defineExpose({ contains: (node: Node | null) => !!node && !!root.value?.contains(node) });
</script>

<template>
	<ul
		:id="listId"
		ref="root"
		role="listbox"
		:aria-label="t('components.team.composer.itemPicker')"
		class="absolute bottom-full left-4 right-4 z-20 mb-2 max-h-64 overflow-y-auto rounded-lg border border-border-subtle bg-bg-elevated py-1 shadow-xl"
		data-testid="team-composer-item-picker"
	>
		<li
			v-for="(item, index) in items"
			:id="`${listId}-${index}`"
			:key="item.id"
			role="option"
			:aria-selected="index === activeIndex"
			tabindex="-1"
			class="flex w-full cursor-pointer items-center gap-2 px-3 py-1.5 text-left text-sm"
			:class="index === activeIndex ? 'bg-bg-surface' : ''"
			@mousedown.prevent
			@mouseenter="emit('hover', index)"
			@click="emit('pick', item)"
		>
			<Icon name="lucide:hash" class="size-3.5 shrink-0 text-text-tertiary" aria-hidden="true" />
			<span class="truncate text-text-primary">{{ item.text }}</span>
		</li>
	</ul>
</template>
