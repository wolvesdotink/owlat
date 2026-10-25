<script setup lang="ts">
/**
 * "Reading" — the per-user Postbox behaviour card, split out of the Preferences
 * hub page so that page stays a composition of sections (the shape Appearance
 * and Language already have) instead of a 500-line form.
 *
 * Every control here writes one field of the single `mailUserSettings` row
 * through usePostboxSettings, and every option registry it renders keeps its
 * labels as catalog KEYS — module scope cannot call `useI18n`, so this is the
 * render boundary that resolves them.
 *
 * The `id` the settings registry anchors its deep links on ("auto-advance",
 * "density", "reading pane") is passed in by the page as a fallthrough
 * attribute, exactly like the neighbouring cards.
 *
 * Each row carries the "changed from default" marker, against the defaults in
 * `utils/postboxReadingDefaults` (what an unset row resolves to).
 */
import type { PostboxAutoAdvanceMode } from '~/utils/postboxAutoAdvance';
import type { PostboxReplyDefaultMode } from '~/utils/postboxReplyDefault';
import { POSTBOX_REPLY_DEFAULT_OPTIONS } from '~/utils/postboxReplyDefault';
import type { PostboxAfterReply } from '~/utils/postboxAfterReply';
import { POSTBOX_AFTER_REPLY_OPTIONS } from '~/utils/postboxAfterReply';
import { useShortcutLabels } from '~/composables/useShortcutLabels';
import type { PostboxDensity } from '~/utils/postboxDensity';
import { POSTBOX_DENSITY_OPTIONS } from '~/utils/postboxDensity';
import type { PostboxReadingPane } from '~/utils/postboxReadingPane';
import { POSTBOX_READING_PANE_OPTIONS } from '~/utils/postboxReadingPane';
import type { PostboxMarkReadPolicy } from '~/utils/postboxMarkReadPolicy';
import { POSTBOX_MARK_READ_POLICY_OPTIONS } from '~/utils/postboxMarkReadPolicy';
import type { PostboxSwipeAction } from '~/utils/postboxSwipe';
import { POSTBOX_SWIPE_ACTION_OPTIONS } from '~/utils/postboxSwipe';
import { POSTBOX_READING_DEFAULTS as DEFAULTS } from '~/utils/postboxReadingDefaults';
import PreferencesSettingRow from './PreferencesSettingRow.vue';

const { t } = useI18n();
const { isEnabled } = useFeatureFlag();
// The reply keys as the person has them bound (a preset or a remap moves them),
// and the composer's fixed opposite-action chord as this machine spells it.
const { labelFor, chordLabel } = useShortcutLabels();

const {
	autoAdvance,
	setAutoAdvance,
	writingSuggestions,
	setWritingSuggestions,
	autoSummarize,
	setAutoSummarize,
	readOnArrival,
	setReadOnArrival,
	replyDefault,
	setReplyDefault,
	afterReply,
	setAfterReply,
	density,
	setDensity,
	readingPane,
	setReadingPane,
	markReadPolicy,
	setMarkReadPolicy,
	swipeLeftAction,
	swipeRightAction,
	setSwipeAction,
	sendSound,
	setSendSound,
	autoLoadImages,
	setAutoLoadImages,
	isSaving,
	isLoading,
} = usePostboxSettings();

type ReadingField = keyof typeof DEFAULTS;

const values = computed<Record<ReadingField, unknown>>(() => ({
	autoAdvance: autoAdvance.value,
	markReadPolicy: markReadPolicy.value,
	density: density.value,
	readingPane: readingPane.value,
	swipeLeftAction: swipeLeftAction.value,
	swipeRightAction: swipeRightAction.value,
	replyDefault: replyDefault.value,
	afterReply: afterReply.value,
	writingSuggestions: writingSuggestions.value,
	autoSummarize: autoSummarize.value,
	readOnArrival: readOnArrival.value,
	autoLoadImages: autoLoadImages.value,
	sendSound: sendSound.value,
}));

/**
 * A row's "changed from default" marker. Hidden until the settings row has
 * answered: while it loads every value reads as a fallback (images as off, on
 * purpose), which is not a choice anyone made.
 */
function isChanged(field: ReadingField): boolean {
	return !isLoading.value && values.value[field] !== DEFAULTS[field];
}

/** Reset writes the default through the row's own setter, like picking it would. */
const RESETS: Record<ReadingField, () => Promise<unknown>> = {
	autoAdvance: () => setAutoAdvance(DEFAULTS.autoAdvance),
	markReadPolicy: () => setMarkReadPolicy(DEFAULTS.markReadPolicy),
	density: () => setDensity(DEFAULTS.density),
	readingPane: () => setReadingPane(DEFAULTS.readingPane),
	swipeLeftAction: () => setSwipeAction('left', DEFAULTS.swipeLeftAction),
	swipeRightAction: () => setSwipeAction('right', DEFAULTS.swipeRightAction),
	replyDefault: () => setReplyDefault(DEFAULTS.replyDefault),
	afterReply: () => setAfterReply(DEFAULTS.afterReply),
	writingSuggestions: () => setWritingSuggestions(DEFAULTS.writingSuggestions),
	autoSummarize: () => setAutoSummarize(DEFAULTS.autoSummarize),
	readOnArrival: () => setReadOnArrival(DEFAULTS.readOnArrival),
	autoLoadImages: () => setAutoLoadImages(DEFAULTS.autoLoadImages),
	sendSound: () => setSendSound(DEFAULTS.sendSound),
};

function resetToDefault(field: ReadingField) {
	void RESETS[field]();
}

function onAutoAdvanceChange(event: Event) {
	const value = (event.target as HTMLSelectElement).value as PostboxAutoAdvanceMode;
	void setAutoAdvance(value);
}

function onReplyDefaultChange(event: Event) {
	const value = (event.target as HTMLSelectElement).value as PostboxReplyDefaultMode;
	void setReplyDefault(value);
}

function onAfterReplyChange(event: Event) {
	const value = (event.target as HTMLSelectElement).value as PostboxAfterReply;
	void setAfterReply(value);
}

function onDensityChange(event: Event) {
	const value = (event.target as HTMLSelectElement).value as PostboxDensity;
	void setDensity(value);
}

function onReadingPaneChange(event: Event) {
	const value = (event.target as HTMLSelectElement).value as PostboxReadingPane;
	void setReadingPane(value);
}

function onMarkReadPolicyChange(event: Event) {
	const value = (event.target as HTMLSelectElement).value as PostboxMarkReadPolicy;
	void setMarkReadPolicy(value);
}

/** Both directions share one handler — the field is the only thing that differs. */
function onSwipeChange(direction: 'left' | 'right', event: Event) {
	const value = (event.target as HTMLSelectElement).value as PostboxSwipeAction;
	void setSwipeAction(direction, value);
}
</script>

<template>
	<section class="card !p-0 mb-6">
		<header class="px-5 py-3 border-b border-border-subtle">
			<h2 class="font-semibold">{{ t('components.preferences.preferencesReading.reading') }}</h2>
		</header>
		<PreferencesSettingRow
			first
			control-id="postbox-auto-advance"
			:label="t('components.preferences.preferencesReading.autoAdvanceLabel')"
			:help="t('components.preferences.preferencesReading.autoAdvanceHelp')"
			:changed="isChanged('autoAdvance')"
			:disabled="isSaving"
			@reset="resetToDefault('autoAdvance')"
		>
			<select
				id="postbox-auto-advance"
				class="input w-full sm:w-64 shrink-0"
				:value="autoAdvance"
				:disabled="isSaving"
				@change="onAutoAdvanceChange"
			>
				<option
					v-for="option in POSTBOX_AUTO_ADVANCE_OPTIONS"
					:key="option.value"
					:value="option.value"
				>
					{{ t(option.label) }}
				</option>
			</select>
		</PreferencesSettingRow>
		<PreferencesSettingRow
			control-id="postbox-mark-read"
			:label="t('components.preferences.preferencesReading.markReadLabel')"
			:help="t('components.preferences.preferencesReading.markReadHelp')"
			:changed="isChanged('markReadPolicy')"
			:disabled="isSaving"
			@reset="resetToDefault('markReadPolicy')"
		>
			<select
				id="postbox-mark-read"
				class="input w-full sm:w-64 shrink-0"
				:value="markReadPolicy"
				:disabled="isSaving"
				@change="onMarkReadPolicyChange"
			>
				<option
					v-for="option in POSTBOX_MARK_READ_POLICY_OPTIONS"
					:key="option.value"
					:value="option.value"
				>
					{{ t(option.label) }}
				</option>
			</select>
		</PreferencesSettingRow>
		<PreferencesSettingRow
			control-id="postbox-density"
			:label="t('components.preferences.preferencesReading.densityLabel')"
			:help="t('components.preferences.preferencesReading.densityHelp')"
			:changed="isChanged('density')"
			:disabled="isSaving"
			@reset="resetToDefault('density')"
		>
			<select
				id="postbox-density"
				class="input w-full sm:w-64 shrink-0"
				:value="density"
				:disabled="isSaving"
				@change="onDensityChange"
			>
				<option v-for="option in POSTBOX_DENSITY_OPTIONS" :key="option.value" :value="option.value">
					{{ t(option.label) }}
				</option>
			</select>
		</PreferencesSettingRow>
		<PreferencesSettingRow
			control-id="postbox-reading-pane"
			:label="t('components.preferences.preferencesReading.readingPaneLabel')"
			:help="t('components.preferences.preferencesReading.readingPaneHelp')"
			:changed="isChanged('readingPane')"
			:disabled="isSaving"
			@reset="resetToDefault('readingPane')"
		>
			<select
				id="postbox-reading-pane"
				class="input w-full sm:w-64 shrink-0"
				:value="readingPane"
				:disabled="isSaving"
				@change="onReadingPaneChange"
			>
				<option
					v-for="option in POSTBOX_READING_PANE_OPTIONS"
					:key="option.value"
					:value="option.value"
				>
					{{ t(option.label) }}
				</option>
			</select>
		</PreferencesSettingRow>
		<!-- Swipe-to-triage (idea 21). Rendered on every device — the gesture only
		     answers to touch and pen, but people configure their phone from their
		     desktop, and a control that hides itself where it is easiest to reach
		     is a control nobody finds. -->
		<PreferencesSettingRow
			control-id="postbox-swipe-left"
			:label="t('components.preferences.preferencesReading.swipeLeftLabel')"
			:help="t('components.preferences.preferencesReading.swipeHelp')"
			:changed="isChanged('swipeLeftAction')"
			:disabled="isSaving"
			@reset="resetToDefault('swipeLeftAction')"
		>
			<select
				id="postbox-swipe-left"
				class="input w-full sm:w-64 shrink-0"
				:value="swipeLeftAction"
				:disabled="isSaving"
				@change="onSwipeChange('left', $event)"
			>
				<option
					v-for="option in POSTBOX_SWIPE_ACTION_OPTIONS"
					:key="option.value"
					:value="option.value"
				>
					{{ t(option.label) }}
				</option>
			</select>
		</PreferencesSettingRow>
		<PreferencesSettingRow
			control-id="postbox-swipe-right"
			:label="t('components.preferences.preferencesReading.swipeRightLabel')"
			:help="t('components.preferences.preferencesReading.swipeRightHelp')"
			:changed="isChanged('swipeRightAction')"
			:disabled="isSaving"
			@reset="resetToDefault('swipeRightAction')"
		>
			<select
				id="postbox-swipe-right"
				class="input w-full sm:w-64 shrink-0"
				:value="swipeRightAction"
				:disabled="isSaving"
				@change="onSwipeChange('right', $event)"
			>
				<option
					v-for="option in POSTBOX_SWIPE_ACTION_OPTIONS"
					:key="option.value"
					:value="option.value"
				>
					{{ t(option.label) }}
				</option>
			</select>
		</PreferencesSettingRow>
		<PreferencesSettingRow
			control-id="postbox-reply-default"
			:label="t('components.preferences.preferencesReading.replyDefaultLabel')"
			:changed="isChanged('replyDefault')"
			:disabled="isSaving"
			@reset="resetToDefault('replyDefault')"
		>
			<template #help>
				<I18nT
					keypath="components.preferences.preferencesReading.replyDefaultHelp"
					tag="p"
					class="text-xs text-text-tertiary mt-0.5"
					scope="global"
				>
					<template #replyKey
						><kbd>{{ labelFor('postbox.reply') ?? '—' }}</kbd></template
					>
					<template #replyAllKey
						><kbd>{{ labelFor('postbox.replyAll') ?? '—' }}</kbd></template
					>
				</I18nT>
			</template>
			<select
				id="postbox-reply-default"
				class="input w-full sm:w-64 shrink-0"
				:value="replyDefault"
				:disabled="isSaving"
				@change="onReplyDefaultChange"
			>
				<option
					v-for="option in POSTBOX_REPLY_DEFAULT_OPTIONS"
					:key="option.value"
					:value="option.value"
				>
					{{ t(option.label) }}
				</option>
			</select>
		</PreferencesSettingRow>
		<PreferencesSettingRow
			control-id="postbox-after-reply"
			:label="t('components.preferences.preferencesReading.afterReplyLabel')"
			:changed="isChanged('afterReply')"
			:disabled="isSaving"
			data-testid="preferences-after-reply"
			@reset="resetToDefault('afterReply')"
		>
			<template #help>
				<I18nT
					keypath="components.preferences.preferencesReading.afterReplyHelp"
					tag="p"
					class="text-xs text-text-tertiary mt-0.5"
					scope="global"
				>
					<template #oppositeKey
						><kbd>{{ chordLabel('mod+alt+Enter') }}</kbd></template
					>
				</I18nT>
			</template>
			<select
				id="postbox-after-reply"
				class="input w-full sm:w-64 shrink-0"
				:value="afterReply"
				:disabled="isSaving"
				@change="onAfterReplyChange"
			>
				<option
					v-for="option in POSTBOX_AFTER_REPLY_OPTIONS"
					:key="option.value"
					:value="option.value"
				>
					{{ t(option.label) }}
				</option>
			</select>
		</PreferencesSettingRow>
		<PreferencesSettingRow
			v-if="isEnabled('ai')"
			layout="switch"
			control-id="postbox-writing-suggestions"
			:label="t('components.preferences.preferencesReading.writingSuggestionsLabel')"
			:help="t('components.preferences.preferencesReading.writingSuggestionsHelp')"
			:changed="isChanged('writingSuggestions')"
			:disabled="isSaving"
			@reset="resetToDefault('writingSuggestions')"
		>
			<UiSwitch
				id="postbox-writing-suggestions"
				:model-value="writingSuggestions"
				:disabled="isSaving"
				@update:model-value="setWritingSuggestions"
			/>
		</PreferencesSettingRow>
		<PreferencesSettingRow
			v-if="isEnabled('ai')"
			layout="switch"
			control-id="postbox-auto-summarize"
			:label="t('components.preferences.preferencesReading.autoSummarizeLabel')"
			:help="t('components.preferences.preferencesReading.autoSummarizeHelp')"
			:changed="isChanged('autoSummarize')"
			:disabled="isSaving"
			@reset="resetToDefault('autoSummarize')"
		>
			<UiSwitch
				id="postbox-auto-summarize"
				:model-value="autoSummarize"
				:disabled="isSaving"
				@update:model-value="setAutoSummarize"
			/>
		</PreferencesSettingRow>
		<PreferencesSettingRow
			v-if="isEnabled('ai')"
			layout="switch"
			control-id="postbox-read-on-arrival"
			:label="t('postbox.arrival.settings.label')"
			:help="t('postbox.arrival.settings.help')"
			:changed="isChanged('readOnArrival')"
			:disabled="isSaving"
			@reset="resetToDefault('readOnArrival')"
		>
			<UiSwitch
				id="postbox-read-on-arrival"
				:model-value="readOnArrival"
				:disabled="isSaving"
				@update:model-value="setReadOnArrival"
			/>
		</PreferencesSettingRow>
		<PreferencesBriefBackfill v-if="isEnabled('ai') && autoSummarize" />
		<PreferencesSettingRow
			layout="switch"
			control-id="postbox-auto-load-images"
			:label="t('components.preferences.preferencesReading.autoLoadImagesLabel')"
			:help="t('components.preferences.preferencesReading.autoLoadImagesHelp')"
			:changed="isChanged('autoLoadImages')"
			:disabled="isSaving"
			@reset="resetToDefault('autoLoadImages')"
		>
			<UiSwitch
				id="postbox-auto-load-images"
				:model-value="autoLoadImages"
				:disabled="isSaving"
				@update:model-value="setAutoLoadImages"
			/>
		</PreferencesSettingRow>
		<PreferencesSettingRow
			layout="switch"
			control-id="postbox-send-sound"
			:label="t('components.preferences.preferencesReading.sendSoundLabel')"
			:help="t('components.preferences.preferencesReading.sendSoundHelp')"
			:changed="isChanged('sendSound')"
			:disabled="isSaving"
			@reset="resetToDefault('sendSound')"
		>
			<UiSwitch
				id="postbox-send-sound"
				:model-value="sendSound"
				:disabled="isSaving"
				@update:model-value="setSendSound"
			/>
		</PreferencesSettingRow>
	</section>
</template>
