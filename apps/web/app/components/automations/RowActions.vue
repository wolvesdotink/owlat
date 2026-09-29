<script setup lang="ts">
/**
 * An automation row's actions, shared by the table and the mobile card list:
 * the pause/activate toggle, edit, and the overflow menu.
 *
 * Every write needs `automations:manage`, so an editor keeps only "View
 * details" — which a draft does not have (it has never run, so there are no
 * analytics), and the menu trigger goes too rather than open an empty menu.
 * Delete is offered only for an automation that is not running; the page's
 * dialog refuses one that became active while it was open.
 */
import type { AutomationListItem } from './ListTable.vue';

const props = defineProps<{
	automation: AutomationListItem;
	canManage: boolean;
	/** This row's pause/activate is in flight. */
	toggling: boolean;
	/** Card layout: 44px touch targets instead of the table's compact icons. */
	touch?: boolean;
}>();

const emit = defineEmits<{
	toggle: [automation: AutomationListItem];
	edit: [automation: AutomationListItem];
	view: [automation: AutomationListItem];
	duplicate: [automation: AutomationListItem];
	delete: [automation: AutomationListItem];
}>();

const { t } = useI18n();

const menuOpen = ref(false);

const isDraft = computed(() => props.automation.status === 'draft');
const isActive = computed(() => props.automation.status === 'active');
const toggleLabel = computed(() =>
	isActive.value
		? t('dashboard.automations.index.actions.pause')
		: t('dashboard.automations.index.actions.activate')
);

const iconButton = computed(() => [
	'flex items-center justify-center flex-shrink-0 rounded-lg transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand',
	props.touch ? 'w-11 h-11' : 'p-2',
]);
const neutralButton = 'text-text-tertiary hover:text-text-primary hover:bg-bg-surface-hover';
</script>

<template>
	<div class="flex items-center justify-end gap-1" @click.stop>
		<button
			v-if="canManage && !isDraft"
			type="button"
			:class="[
				iconButton,
				isActive
					? 'text-warning hover:text-warning hover:bg-warning/10'
					: 'text-success hover:text-success hover:bg-success/10',
			]"
			:title="toggleLabel"
			:aria-label="toggleLabel"
			:disabled="toggling"
			@click="emit('toggle', automation)"
		>
			<Icon
				v-if="toggling"
				name="lucide:loader-2"
				class="w-4 h-4 animate-spin motion-reduce:animate-none"
			/>
			<Icon v-else-if="isActive" name="lucide:pause" class="w-4 h-4" />
			<Icon v-else name="lucide:play" class="w-4 h-4" />
		</button>
		<button
			v-if="canManage"
			type="button"
			:class="[iconButton, neutralButton]"
			:title="t('common.edit')"
			:aria-label="t('common.edit')"
			@click="emit('edit', automation)"
		>
			<Icon name="lucide:pencil" class="w-4 h-4" />
		</button>
		<UiDropdownMenu v-if="canManage || !isDraft" v-model:open="menuOpen">
			<template #trigger>
				<button
					type="button"
					:class="[iconButton, neutralButton]"
					:title="t('dashboard.automations.index.actions.more')"
					:aria-label="t('dashboard.automations.index.actions.more')"
				>
					<Icon name="lucide:more-vertical" class="w-4 h-4" />
				</button>
			</template>
			<UiDropdownMenuItem v-if="!isDraft" icon="lucide:zap" @click="emit('view', automation)">
				{{ t('dashboard.automations.index.actions.viewDetails') }}
			</UiDropdownMenuItem>
			<template v-if="canManage">
				<UiDropdownMenuItem icon="lucide:pencil" @click="emit('edit', automation)">
					{{ t('common.edit') }}
				</UiDropdownMenuItem>
				<UiDropdownMenuItem icon="lucide:copy" @click="emit('duplicate', automation)">
					{{ t('common.duplicate') }}
				</UiDropdownMenuItem>
				<UiDropdownMenuItem
					v-if="!isDraft"
					:icon="isActive ? 'lucide:pause' : 'lucide:play'"
					:disabled="toggling"
					@click="emit('toggle', automation)"
				>
					{{ toggleLabel }}
				</UiDropdownMenuItem>
				<template v-if="!isActive">
					<UiDropdownDivider />
					<UiDropdownMenuItem icon="lucide:trash-2" danger @click="emit('delete', automation)">
						{{ t('common.delete') }}
					</UiDropdownMenuItem>
				</template>
			</template>
		</UiDropdownMenu>
	</div>
</template>
