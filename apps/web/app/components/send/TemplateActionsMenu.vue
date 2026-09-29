<script setup lang="ts" generic="T extends TemplateListItem">
/**
 * A template row's overflow menu: the page's own actions first, then edit,
 * duplicate and delete. Duplicate and delete need `templates:manage`, so they
 * only render for `canManage`.
 *
 * Each menu owns its open state, instead of a page-wide record keyed by row id.
 */
import type { TemplateListItem, TemplateRowAction } from '~/composables/useTemplateList';

withDefaults(
	defineProps<{
		item: T;
		canManage: boolean;
		actions?: readonly TemplateRowAction<T>[];
		/** The table has its own edit button beside the menu. */
		withEdit?: boolean;
	}>(),
	{ actions: () => [], withEdit: true }
);

const emit = defineEmits<{ edit: [item: T]; duplicate: [item: T]; delete: [item: T] }>();

const { t } = useI18n();

const open = ref(false);
</script>

<template>
	<UiDropdownMenu v-model:open="open" @click.stop>
		<template #trigger>
			<UiButton variant="ghost" size="sm" :aria-label="t('shared.templateList.moreActions')">
				<Icon name="lucide:more-vertical" class="w-4 h-4" />
			</UiButton>
		</template>
		<UiDropdownMenuItem
			v-for="action in actions"
			:key="action.key"
			:icon="action.icon"
			@click="action.run(item)"
		>
			{{ action.label }}
		</UiDropdownMenuItem>
		<UiDropdownMenuItem v-if="withEdit" icon="lucide:pencil" @click="emit('edit', item)">
			{{ t('common.edit') }}
		</UiDropdownMenuItem>
		<template v-if="canManage">
			<UiDropdownMenuItem icon="lucide:copy" @click="emit('duplicate', item)">
				{{ t('common.duplicate') }}
			</UiDropdownMenuItem>
			<UiDropdownDivider />
			<UiDropdownMenuItem icon="lucide:trash-2" danger @click="emit('delete', item)">
				{{ t('common.delete') }}
			</UiDropdownMenuItem>
		</template>
	</UiDropdownMenu>
</template>
