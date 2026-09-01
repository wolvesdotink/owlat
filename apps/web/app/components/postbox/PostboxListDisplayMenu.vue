<script setup lang="ts">
/**
 * The list header's one "Display" menu.
 *
 * Four persisted preferences used to be four pieces of permanent chrome (or no
 * chrome at all): a five-segment view-mode control that could not fit the list
 * pane and shipped its own horizontal scroller, a sort toggle, and density and
 * reading-pane pickers that only existed on the preferences page. They already
 * live together in state — this is the surface that finally says so.
 *
 * Pure presentation over semantic emits: every pick routes back to the layout's
 * existing setters, so the menu owns no preference itself. Each group is a
 * radio list (`menuitemradio` + `aria-checked`), which is what a "one of these
 * is active" preference actually is; picking the active option is a no-op.
 *
 * View mode is inbox-only, so its group renders only when the layout hands over
 * the options — every other folder always renders flat.
 */
import type { PostboxDensity } from '~/utils/postboxDensity';
import { POSTBOX_DENSITY_OPTIONS } from '~/utils/postboxDensity';
import type { PostboxReadingPane } from '~/utils/postboxReadingPane';
import { POSTBOX_READING_PANE_OPTIONS } from '~/utils/postboxReadingPane';
import type { PostboxSortOrder } from '~/utils/postboxSortOrder';
import { POSTBOX_SORT_ORDER_OPTIONS } from '~/utils/postboxSortOrder';

defineProps<{
	/** Inbox-only list renderer; absent options hide the group entirely. */
	viewMode?: string;
	viewModeOptions?: Array<{ value: string; label: string }>;
	sortOrder?: string;
	density?: PostboxDensity;
	readingPane?: PostboxReadingPane;
}>();

const emit = defineEmits<{
	'select-view-mode': [value: string];
	'select-sort-order': [value: PostboxSortOrder];
	'select-density': [value: PostboxDensity];
	'select-reading-pane': [value: PostboxReadingPane];
}>();

const { t } = useI18n();

/** Shared by all four groups — one string, not four copies drifting apart. */
const HEADING_CLASS = 'px-3 pt-1.5 pb-1 text-2xs uppercase tracking-wider text-text-tertiary';
const ITEM_CLASS =
	'w-full flex items-center gap-2 px-3 py-1.5 text-sm text-left whitespace-nowrap text-text-primary hover:bg-bg-surface';
</script>

<template>
	<PostboxOverflowMenu
		icon="lucide:sliders-horizontal"
		:label="t('components.postbox.postboxListDisplayMenu.label')"
		:trigger-text="t('components.postbox.postboxListDisplayMenu.display')"
		trigger-class="px-2 py-1 text-text-secondary"
	>
		<template #default="{ close }">
			<template v-if="viewModeOptions">
				<p :class="HEADING_CLASS">{{ t('components.postbox.postboxLayout.inboxView') }}</p>
				<button
					v-for="option in viewModeOptions"
					:key="option.value"
					type="button"
					role="menuitemradio"
					:aria-checked="viewMode === option.value"
					:class="ITEM_CLASS"
					@click="
						emit('select-view-mode', option.value);
						close();
					"
				>
					<Icon
						name="lucide:check"
						class="w-3.5 h-3.5 flex-shrink-0 text-brand"
						:class="{ invisible: viewMode !== option.value }"
						aria-hidden="true"
					/>
					{{ option.label }}
				</button>
				<div class="my-1 border-t border-border-subtle" />
			</template>

			<p :class="HEADING_CLASS">
				{{ t('components.postbox.postboxListDisplayMenu.sortOrder') }}
			</p>
			<button
				v-for="option in POSTBOX_SORT_ORDER_OPTIONS"
				:key="option.value"
				type="button"
				role="menuitemradio"
				:aria-checked="sortOrder === option.value"
				:class="ITEM_CLASS"
				@click="
					emit('select-sort-order', option.value);
					close();
				"
			>
				<Icon
					name="lucide:check"
					class="w-3.5 h-3.5 flex-shrink-0 text-brand"
					:class="{ invisible: sortOrder !== option.value }"
					aria-hidden="true"
				/>
				{{ t(option.label) }}
			</button>
			<div class="my-1 border-t border-border-subtle" />

			<p :class="HEADING_CLASS">
				{{ t('components.postbox.postboxListDisplayMenu.density') }}
			</p>
			<button
				v-for="option in POSTBOX_DENSITY_OPTIONS"
				:key="option.value"
				type="button"
				role="menuitemradio"
				:aria-checked="density === option.value"
				:class="ITEM_CLASS"
				@click="
					emit('select-density', option.value);
					close();
				"
			>
				<Icon
					name="lucide:check"
					class="w-3.5 h-3.5 flex-shrink-0 text-brand"
					:class="{ invisible: density !== option.value }"
					aria-hidden="true"
				/>
				{{ t(option.label) }}
			</button>
			<div class="my-1 border-t border-border-subtle" />

			<p :class="HEADING_CLASS">
				{{ t('components.postbox.postboxListDisplayMenu.readingPane') }}
			</p>
			<button
				v-for="option in POSTBOX_READING_PANE_OPTIONS"
				:key="option.value"
				type="button"
				role="menuitemradio"
				:aria-checked="readingPane === option.value"
				:class="ITEM_CLASS"
				@click="
					emit('select-reading-pane', option.value);
					close();
				"
			>
				<Icon
					name="lucide:check"
					class="w-3.5 h-3.5 flex-shrink-0 text-brand"
					:class="{ invisible: readingPane !== option.value }"
					aria-hidden="true"
				/>
				{{ t(option.label) }}
			</button>
		</template>
	</PostboxOverflowMenu>
</template>
