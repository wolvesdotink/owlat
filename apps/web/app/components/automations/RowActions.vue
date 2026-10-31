<script setup lang="ts">
/**
 * An automation row's actions, shared by the table and the mobile card list:
 * the active/paused switch, edit, and the overflow menu. The switch shows the
 * state (on = active) and flipping it asks the page to pause or resume; the
 * page offers the Undo.
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
// A switch names the setting, never its state: aria-checked says on or off.
const switchLabel = computed(() =>
	t('dashboard.automations.index.actions.activeSwitch', { name: props.automation.name })
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
// The switch track is 44×24. On cards a transparent ::before on the switch
// button itself grows its hit area to 56×44, so a tap anywhere in the touch
// target reaches the real control (and its disabled state) without enlarging
// the track.
const switchHitArea = computed(() =>
	props.touch ? "before:absolute before:-inset-x-1.5 before:-inset-y-2.5 before:content-['']" : ''
);
</script>

<template>
	<div class="flex items-center justify-end gap-1" @click.stop>
		<UiTooltip v-if="canManage && !isDraft" :text="toggleLabel">
			<span :class="['flex items-center justify-center flex-shrink-0', touch ? 'w-14 h-11' : '']">
				<UiSwitch
					:model-value="isActive"
					:label="switchLabel"
					:disabled="toggling"
					:class="switchHitArea"
					@update:model-value="emit('toggle', automation)"
				/>
			</span>
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
