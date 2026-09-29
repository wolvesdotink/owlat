<script setup lang="ts" generic="T extends TemplateListItem">
/**
 * The list view of a template list below `md`, where the table's columns
 * cannot fit: the same rows as stacked cards, with the row actions folded into
 * the overflow menu.
 */
import type { TemplateListItem, TemplateRowAction } from '~/composables/useTemplateList';
import { formatDate } from '~/utils/formatters';

withDefaults(
	defineProps<{
		items: readonly T[];
		canManage: boolean;
		actions?: readonly TemplateRowAction<T>[];
	}>(),
	{ actions: () => [] }
);

const emit = defineEmits<{ edit: [item: T]; duplicate: [item: T]; delete: [item: T] }>();

defineSlots<{
	/** Extra chips beside the status badge. Rendered inside the row's button. */
	meta?: (props: { item: T }) => unknown;
}>();

const { t, locale } = useI18n();
</script>

<template>
	<ul class="divide-y divide-border-subtle">
		<li v-for="item in items" :key="item._id">
			<div class="flex items-start gap-3 px-4 py-3">
				<button
					type="button"
					class="flex-1 min-w-0 text-left"
					:aria-label="t('shared.templateList.editAriaLabel', { name: item.name })"
					@click="emit('edit', item)"
				>
					<span class="block text-text-primary font-medium truncate">{{ item.name }}</span>
					<span class="block text-sm text-text-secondary truncate">
						{{ item.subject || t('shared.templateList.noSubject') }}
					</span>
					<span class="flex flex-wrap items-center gap-2 mt-1.5">
						<SendTemplateStatusBadge :status="item.status" />
						<slot name="meta" :item="item" />
						<span class="text-xs text-text-tertiary">
							{{
								t('shared.templateList.updatedAt', {
									date: formatDate(item.updatedAt, 'medium', locale),
								})
							}}
						</span>
					</span>
				</button>
				<SendTemplateActionsMenu
					:item="item"
					:can-manage="canManage"
					:actions="actions"
					@edit="emit('edit', $event)"
					@duplicate="emit('duplicate', $event)"
					@delete="emit('delete', $event)"
				/>
			</div>
		</li>
	</ul>
</template>
