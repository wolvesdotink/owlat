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
import { automationRowVerbs, type AutomationRowVerbId } from '~/utils/automationRowVerbs';

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

// The same verbs, in the same order, as the row's context menu.
const verbs = computed(() => automationRowVerbs(props.automation.status, props.canManage));

function runVerb(id: AutomationRowVerbId) {
	switch (id) {
		case 'view':
			emit('view', props.automation);
			break;
		case 'edit':
			emit('edit', props.automation);
			break;
		case 'duplicate':
			emit('duplicate', props.automation);
			break;
		case 'toggle':
			emit('toggle', props.automation);
			break;
		case 'delete':
			emit('delete', props.automation);
			break;
	}
}

const iconButton = computed(() => [
	'flex items-center justify-center flex-shrink-0 rounded-lg transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand',
	props.touch ? 'w-11 h-11' : 'p-2',
]);
const neutralButton = 'text-text-tertiary hover:text-text-primary hover:bg-bg-surface-hover';
</script>

<template>
	<div class="flex items-center justify-end gap-1" @click.stop>
		<UiTooltip v-if="canManage && !isDraft" :text="toggleLabel">
			<button
				type="button"
				:class="[
					iconButton,
					isActive
						? 'text-warning hover:text-warning hover:bg-warning/10'
						: 'text-success hover:text-success hover:bg-success/10',
				]"
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
		</UiTooltip>
		<UiTooltip v-if="canManage" :text="t('common.edit')">
			<button
				type="button"
				:class="[iconButton, neutralButton]"
				:aria-label="t('common.edit')"
				@click="emit('edit', automation)"
			>
				<Icon name="lucide:pencil" class="w-4 h-4" />
			</button>
		</UiTooltip>
		<UiDropdownMenu v-if="verbs.length > 0" v-model:open="menuOpen">
			<template #trigger>
				<UiTooltip :text="t('dashboard.automations.index.actions.more')">
					<button
						type="button"
						:class="[iconButton, neutralButton]"
						:aria-label="t('dashboard.automations.index.actions.more')"
					>
						<Icon name="lucide:more-vertical" class="w-4 h-4" />
					</button>
				</UiTooltip>
			</template>
			<template v-for="verb in verbs" :key="verb.id">
				<UiDropdownDivider v-if="verb.separatorBefore" />
				<UiDropdownMenuItem
					:icon="verb.icon"
					:danger="verb.danger"
					:disabled="verb.id === 'toggle' && toggling"
					@click="runVerb(verb.id)"
				>
					{{ t(verb.labelKey) }}
				</UiDropdownMenuItem>
			</template>
		</UiDropdownMenu>
	</div>
</template>
