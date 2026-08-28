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
 */
import type { PostboxAutoAdvanceMode } from '~/utils/postboxAutoAdvance';
import type { PostboxReplyDefaultMode } from '~/utils/postboxReplyDefault';
import { POSTBOX_REPLY_DEFAULT_OPTIONS } from '~/utils/postboxReplyDefault';
import type { PostboxDensity } from '~/utils/postboxDensity';
import { POSTBOX_DENSITY_OPTIONS } from '~/utils/postboxDensity';
import type { PostboxReadingPane } from '~/utils/postboxReadingPane';
import { POSTBOX_READING_PANE_OPTIONS } from '~/utils/postboxReadingPane';
import type { PostboxMarkReadPolicy } from '~/utils/postboxMarkReadPolicy';
import { POSTBOX_MARK_READ_POLICY_OPTIONS } from '~/utils/postboxMarkReadPolicy';

const { t } = useI18n();
const { isEnabled } = useFeatureFlag();

const {
	autoAdvance,
	setAutoAdvance,
	writingSuggestions,
	setWritingSuggestions,
	autoSummarize,
	setAutoSummarize,
	replyDefault,
	setReplyDefault,
	density,
	setDensity,
	readingPane,
	setReadingPane,
	markReadPolicy,
	setMarkReadPolicy,
	sendSound,
	setSendSound,
	isSaving,
} = usePostboxSettings();

function onAutoAdvanceChange(event: Event) {
	const value = (event.target as HTMLSelectElement).value as PostboxAutoAdvanceMode;
	void setAutoAdvance(value);
}

function onReplyDefaultChange(event: Event) {
	const value = (event.target as HTMLSelectElement).value as PostboxReplyDefaultMode;
	void setReplyDefault(value);
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

function onWritingSuggestionsChange(event: Event) {
	void setWritingSuggestions((event.target as HTMLInputElement).checked);
}

function onAutoSummarizeChange(event: Event) {
	void setAutoSummarize((event.target as HTMLInputElement).checked);
}

function onSendSoundChange(event: Event) {
	void setSendSound((event.target as HTMLInputElement).checked);
}
</script>

<template>
	<section class="card !p-0 mb-6">
		<header class="px-5 py-3 border-b border-border-subtle">
			<h2 class="font-semibold">{{ t('components.preferences.preferencesReading.reading') }}</h2>
		</header>
		<div class="px-5 py-4 flex items-center justify-between gap-4">
			<div class="min-w-0">
				<label for="postbox-auto-advance" class="font-medium text-sm block">
					{{ t('components.preferences.preferencesReading.autoAdvanceLabel') }}
				</label>
				<p class="text-xs text-text-tertiary mt-0.5">
					{{ t('components.preferences.preferencesReading.autoAdvanceHelp') }}
				</p>
			</div>
			<select
				id="postbox-auto-advance"
				class="input w-64 shrink-0"
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
		</div>
		<div
			class="px-5 py-4 flex items-center justify-between gap-4 border-t border-border-subtle"
		>
			<div class="min-w-0">
				<label for="postbox-mark-read" class="font-medium text-sm block">
					{{ t('components.preferences.preferencesReading.markReadLabel') }}
				</label>
				<p class="text-xs text-text-tertiary mt-0.5">
					{{ t('components.preferences.preferencesReading.markReadHelp') }}
				</p>
			</div>
			<select
				id="postbox-mark-read"
				class="input w-64 shrink-0"
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
		</div>
		<div
			class="px-5 py-4 flex items-center justify-between gap-4 border-t border-border-subtle"
		>
			<div class="min-w-0">
				<label for="postbox-density" class="font-medium text-sm block">
					{{ t('components.preferences.preferencesReading.densityLabel') }}
				</label>
				<p class="text-xs text-text-tertiary mt-0.5">
					{{ t('components.preferences.preferencesReading.densityHelp') }}
				</p>
			</div>
			<select
				id="postbox-density"
				class="input w-64 shrink-0"
				:value="density"
				:disabled="isSaving"
				@change="onDensityChange"
			>
				<option
					v-for="option in POSTBOX_DENSITY_OPTIONS"
					:key="option.value"
					:value="option.value"
				>
					{{ t(option.label) }}
				</option>
			</select>
		</div>
		<div
			class="px-5 py-4 flex items-center justify-between gap-4 border-t border-border-subtle"
		>
			<div class="min-w-0">
				<label for="postbox-reading-pane" class="font-medium text-sm block">
					{{ t('components.preferences.preferencesReading.readingPaneLabel') }}
				</label>
				<p class="text-xs text-text-tertiary mt-0.5">
					{{ t('components.preferences.preferencesReading.readingPaneHelp') }}
				</p>
			</div>
			<select
				id="postbox-reading-pane"
				class="input w-64 shrink-0"
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
		</div>
		<div
			class="px-5 py-4 flex items-center justify-between gap-4 border-t border-border-subtle"
		>
			<div class="min-w-0">
				<label for="postbox-reply-default" class="font-medium text-sm block">
					{{ t('components.preferences.preferencesReading.replyDefaultLabel') }}
				</label>
				<I18nT
					keypath="components.preferences.preferencesReading.replyDefaultHelp"
					tag="p"
					class="text-xs text-text-tertiary mt-0.5"
					scope="global"
				>
					<template #replyKey><kbd>r</kbd></template>
					<template #replyAllKey><kbd>a</kbd></template>
				</I18nT>
			</div>
			<select
				id="postbox-reply-default"
				class="input w-64 shrink-0"
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
		</div>
		<div
			v-if="isEnabled('ai')"
			class="px-5 py-4 flex items-center justify-between gap-4 border-t border-border-subtle"
		>
			<div class="min-w-0">
				<label for="postbox-writing-suggestions" class="font-medium text-sm block">
					{{ t('components.preferences.preferencesReading.writingSuggestionsLabel') }}
				</label>
				<p class="text-xs text-text-tertiary mt-0.5">
					{{ t('components.preferences.preferencesReading.writingSuggestionsHelp') }}
				</p>
			</div>
			<input
				id="postbox-writing-suggestions"
				type="checkbox"
				class="shrink-0 h-4 w-4"
				:checked="writingSuggestions"
				:disabled="isSaving"
				@change="onWritingSuggestionsChange"
			/>
		</div>
		<div
			v-if="isEnabled('ai')"
			class="px-5 py-4 flex items-center justify-between gap-4 border-t border-border-subtle"
		>
			<div class="min-w-0">
				<label for="postbox-auto-summarize" class="font-medium text-sm block">
					{{ t('components.preferences.preferencesReading.autoSummarizeLabel') }}
				</label>
				<p class="text-xs text-text-tertiary mt-0.5">
					{{ t('components.preferences.preferencesReading.autoSummarizeHelp') }}
				</p>
			</div>
			<input
				id="postbox-auto-summarize"
				type="checkbox"
				class="shrink-0 h-4 w-4"
				:checked="autoSummarize"
				:disabled="isSaving"
				@change="onAutoSummarizeChange"
			/>
		</div>
		<div
			class="px-5 py-4 flex items-center justify-between gap-4 border-t border-border-subtle"
		>
			<div class="min-w-0">
				<label for="postbox-send-sound" class="font-medium text-sm block">
					{{ t('components.preferences.preferencesReading.sendSoundLabel') }}
				</label>
				<p class="text-xs text-text-tertiary mt-0.5">
					{{ t('components.preferences.preferencesReading.sendSoundHelp') }}
				</p>
			</div>
			<input
				id="postbox-send-sound"
				type="checkbox"
				class="shrink-0 h-4 w-4"
				:checked="sendSound"
				:disabled="isSaving"
				@change="onSendSoundChange"
			/>
		</div>
	</section>
</template>
