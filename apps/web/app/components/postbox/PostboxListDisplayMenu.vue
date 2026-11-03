<script setup lang="ts">
/**
 * The list header's one "Display" menu.
 *
 * Five persisted preferences (view mode, sort, density, unread style and
 * reading pane) sit behind one menu rather than as permanent chrome: a
 * five-segment view-mode control cannot fit the list pane without its own
 * horizontal scroller. They live together in state, and this is the surface
 * that says so.
 *
 * Pure presentation over semantic emits: every pick routes back to the layout's
 * existing setters, so the menu owns no preference itself. Each group is a
 * radio list (`menuitemradio` + `aria-checked`), which is what a "one of these
 * is active" preference actually is; picking the active option is a no-op.
 *
 * View mode is inbox-only, so its group renders only when the layout hands over
 * the options — every other folder always renders flat. Each view carries a
 * one-line description under its name: five bare names cannot be told apart
 * without trying each one. The description is `aria-hidden` and referenced by
 * `aria-describedby`, so a screen reader announces the name, then what it does.
 */
import type { PostboxDensity } from '~/utils/postboxDensity';
import { POSTBOX_DENSITY_OPTIONS } from '~/utils/postboxDensity';
import type { PostboxReadingPane } from '~/utils/postboxReadingPane';
import { POSTBOX_READING_PANE_OPTIONS } from '~/utils/postboxReadingPane';
import type { PostboxSortOrder } from '~/utils/postboxSortOrder';
import { POSTBOX_SORT_ORDER_OPTIONS } from '~/utils/postboxSortOrder';
import type { PostboxUnreadStyle } from '~/utils/postboxUnreadStyle';
import { POSTBOX_UNREAD_STYLE_OPTIONS } from '~/utils/postboxUnreadStyle';
import { CheckIcon, Slider1Icon } from '@coolicons/vue';

defineProps<{
	/** Inbox-only list renderer; absent options hide the group entirely. */
	viewMode?: string;
	viewModeOptions?: Array<{ value: string; label: string; description?: string }>;
	/** Arrival direction; absent hides the group, for a list with one fixed order. */
	sortOrder?: string;
	density?: PostboxDensity;
	unreadStyle?: PostboxUnreadStyle;
	readingPane?: PostboxReadingPane;
}>();

const emit = defineEmits<{
	'select-view-mode': [value: string];
	'select-sort-order': [value: PostboxSortOrder];
	'select-density': [value: PostboxDensity];
	'select-unread-style': [value: PostboxUnreadStyle];
	'select-reading-pane': [value: PostboxReadingPane];
}>();

const { t } = useI18n();
const descriptionIdPrefix = useId();

/** Shared by all five groups — one string, not five copies drifting apart. */
const HEADING_CLASS = 'px-3 pt-1.5 pb-1 text-2xs uppercase tracking-wider text-text-tertiary';
const ITEM_CLASS =
	'w-full flex items-center gap-2 px-3 py-1.5 text-sm text-left whitespace-nowrap text-text-primary hover:bg-bg-surface';
/** A view-mode item: the check sits beside the name, above its description. */
const VIEW_MODE_ITEM_CLASS = ITEM_CLASS.replace('items-center', 'items-start');
</script>

<template>
	<PostboxOverflowMenu
		:icon="Slider1Icon"
		:label="t('components.postbox.postboxListDisplayMenu.label')"
		:trigger-text="t('components.postbox.postboxListDisplayMenu.display')"
		trigger-class="px-2 py-1 text-text-secondary"
	>
		<template #default="{ close }">
			<!-- Five groups outgrow a laptop-height window, and the panel opens below
			     the list header, so the content scrolls inside the panel rather than
			     past the bottom of the screen. -->
			<div class="max-h-[calc(100dvh-10rem)] overflow-y-auto">
				<template v-if="viewModeOptions">
					<p :class="HEADING_CLASS">{{ t('components.postbox.postboxLayout.inboxView') }}</p>
					<button
						v-for="option in viewModeOptions"
						:key="option.value"
						type="button"
						role="menuitemradio"
						:aria-checked="viewMode === option.value"
						:aria-describedby="
							option.description ? `${descriptionIdPrefix}-${option.value}` : undefined
						"
						:class="VIEW_MODE_ITEM_CLASS"
						@click="
							emit('select-view-mode', option.value);
							close();
						"
					>
						<CheckIcon
							class="w-3.5 h-3.5 mt-0.5 flex-shrink-0 text-brand"
							:class="{ invisible: viewMode !== option.value }"
							aria-hidden="true"
						/>
						<span class="flex flex-col">
							{{ option.label }}
							<span
								v-if="option.description"
								:id="`${descriptionIdPrefix}-${option.value}`"
								aria-hidden="true"
								class="max-w-60 whitespace-normal text-xs text-text-tertiary"
							>
								{{ option.description }}
							</span>
						</span>
					</button>
					<div class="my-1 border-t border-border-subtle" />
				</template>

				<template v-if="sortOrder">
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
						<CheckIcon
							class="w-3.5 h-3.5 flex-shrink-0 text-brand"
							:class="{ invisible: sortOrder !== option.value }"
							aria-hidden="true"
						/>
						{{ t(option.label) }}
					</button>
					<div class="my-1 border-t border-border-subtle" />
				</template>

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
					<CheckIcon
						class="w-3.5 h-3.5 flex-shrink-0 text-brand"
						:class="{ invisible: density !== option.value }"
						aria-hidden="true"
					/>
					{{ t(option.label) }}
				</button>
				<div class="my-1 border-t border-border-subtle" />

				<p :class="HEADING_CLASS">
					{{ t('components.postbox.postboxListDisplayMenu.unreadStyle') }}
				</p>
				<button
					v-for="option in POSTBOX_UNREAD_STYLE_OPTIONS"
					:key="option.value"
					type="button"
					role="menuitemradio"
					:aria-checked="unreadStyle === option.value"
					:class="ITEM_CLASS"
					@click="
						emit('select-unread-style', option.value);
						close();
					"
				>
					<CheckIcon
						class="w-3.5 h-3.5 flex-shrink-0 text-brand"
						:class="{ invisible: unreadStyle !== option.value }"
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
					<CheckIcon
						class="w-3.5 h-3.5 flex-shrink-0 text-brand"
						:class="{ invisible: readingPane !== option.value }"
						aria-hidden="true"
					/>
					{{ t(option.label) }}
				</button>
			</div>
		</template>
	</PostboxOverflowMenu>
</template>
