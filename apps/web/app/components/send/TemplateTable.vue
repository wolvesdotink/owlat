<script setup lang="ts" generic="T extends TemplateListItem">
/**
 * The list view of a template list from `md` up. Each row opens by click,
 * Enter or Space; the page supplies the data cells through `#cells` and the
 * trailing action cell (page actions, edit, overflow menu) is rendered here.
 */
import type { TemplateListItem, TemplateRowAction } from '~/composables/useTemplateList';

const props = withDefaults(
	defineProps<{
		items: readonly T[];
		/** Header labels, one per cell the `#cells` slot renders. */
		columns: readonly string[];
		canManage: boolean;
		actions?: readonly TemplateRowAction<T>[];
	}>(),
	{ actions: () => [] }
);

const emit = defineEmits<{ edit: [item: T]; duplicate: [item: T]; delete: [item: T] }>();

defineSlots<{
	/** The row's `<td>` cells, in `columns` order. */
	cells: (props: { item: T }) => unknown;
}>();

const { t } = useI18n();

const inlineActions = computed(() => props.actions.filter((action) => action.inline));

const iconButton =
	'p-2 rounded-lg text-text-tertiary hover:text-text-primary hover:bg-bg-surface-hover transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand';
</script>

<template>
	<div class="overflow-x-auto">
		<table class="w-full">
			<thead>
				<tr class="border-b border-border-subtle">
					<th
						v-for="column in columns"
						:key="column"
						class="text-left px-6 py-4 text-sm font-medium text-text-secondary whitespace-nowrap"
					>
						{{ column }}
					</th>
					<th class="text-right px-6 py-4 text-sm font-medium text-text-secondary">
						{{ t('common.actions') }}
					</th>
				</tr>
			</thead>
			<tbody>
				<tr
					v-for="item in items"
					:key="item._id"
					class="border-b border-border-subtle last:border-b-0 hover:bg-bg-surface transition-colors cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand focus-visible:ring-inset"
					role="button"
					tabindex="0"
					:aria-label="t('shared.templateList.editAriaLabel', { name: item.name })"
					@click="emit('edit', item)"
					@keydown.enter.self="emit('edit', item)"
					@keydown.space.self.prevent="emit('edit', item)"
				>
					<slot name="cells" :item="item" />
					<td class="px-6 py-4">
						<div class="flex items-center justify-end gap-1" @click.stop>
							<button
								v-for="action in inlineActions"
								:key="action.key"
								type="button"
								:class="iconButton"
								:title="action.label"
								:aria-label="action.label"
								@click="action.run(item)"
							>
								<Icon :name="action.icon" class="w-4 h-4" />
							</button>
							<button
								type="button"
								:class="iconButton"
								:title="t('common.edit')"
								:aria-label="t('common.edit')"
								@click="emit('edit', item)"
							>
								<Icon name="lucide:pencil" class="w-4 h-4" />
							</button>
							<SendTemplateActionsMenu
								v-if="canManage || actions.length > 0"
								:item="item"
								:can-manage="canManage"
								:actions="actions"
								:with-edit="false"
								@duplicate="emit('duplicate', $event)"
								@delete="emit('delete', $event)"
							/>
						</div>
					</td>
				</tr>
			</tbody>
		</table>
	</div>
</template>
