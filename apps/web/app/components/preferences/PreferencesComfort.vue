<script setup lang="ts">
/**
 * Reading comfort: mail text size and reading width, higher contrast, an in-app
 * "Reduce motion" switch, and list density for the Team Inbox, contacts and
 * campaigns. Device-local like the theme (composables/useReadingComfort), so
 * the card shows for everyone, mail or not, and every change applies at once.
 */
import { useReadingComfort } from '~/composables/useReadingComfort';
import PreferencesSettingRow from './PreferencesSettingRow.vue';
import {
	LIST_DENSITY_OPTIONS,
	MAIL_TEXT_SIZE_OPTIONS,
	READING_WIDTH_OPTIONS,
	type ListDensity,
	type MailTextSize,
	type ReadingWidth,
} from '~/utils/readingComfort';

const { t } = useI18n();
const { comfort, set, reset, isChanged } = useReadingComfort();

const key = (leaf: string) => `components.preferences.preferencesComfort.${leaf}`;

function selected<T extends string>(event: Event): T {
	return (event.target as HTMLSelectElement).value as T;
}
</script>

<template>
	<section class="card !p-0 mb-6">
		<header class="px-5 py-3 border-b border-border-subtle">
			<h2 class="font-semibold">{{ t(key('title')) }}</h2>
			<p class="text-sm text-text-secondary">{{ t(key('subtitle')) }}</p>
		</header>
		<PreferencesSettingRow
			first
			control-id="comfort-text-size"
			:label="t(key('textSizeLabel'))"
			:help="t(key('textSizeHelp'))"
			:changed="isChanged('textSize')"
			@reset="reset('textSize')"
		>
			<select
				id="comfort-text-size"
				class="input w-full sm:w-64 shrink-0"
				:value="comfort.textSize"
				@change="set('textSize', selected<MailTextSize>($event))"
			>
				<option v-for="option in MAIL_TEXT_SIZE_OPTIONS" :key="option.value" :value="option.value">
					{{ t(option.label) }}
				</option>
			</select>
		</PreferencesSettingRow>
		<PreferencesSettingRow
			control-id="comfort-reading-width"
			:label="t(key('readingWidthLabel'))"
			:help="t(key('readingWidthHelp'))"
			:changed="isChanged('readingWidth')"
			@reset="reset('readingWidth')"
		>
			<select
				id="comfort-reading-width"
				class="input w-full sm:w-64 shrink-0"
				:value="comfort.readingWidth"
				@change="set('readingWidth', selected<ReadingWidth>($event))"
			>
				<option v-for="option in READING_WIDTH_OPTIONS" :key="option.value" :value="option.value">
					{{ t(option.label) }}
				</option>
			</select>
		</PreferencesSettingRow>
		<PreferencesSettingRow
			control-id="comfort-list-density"
			:label="t(key('listDensityLabel'))"
			:help="t(key('listDensityHelp'))"
			:changed="isChanged('listDensity')"
			@reset="reset('listDensity')"
		>
			<select
				id="comfort-list-density"
				class="input w-full sm:w-64 shrink-0"
				:value="comfort.listDensity"
				@change="set('listDensity', selected<ListDensity>($event))"
			>
				<option v-for="option in LIST_DENSITY_OPTIONS" :key="option.value" :value="option.value">
					{{ t(option.label) }}
				</option>
			</select>
		</PreferencesSettingRow>
		<PreferencesSettingRow
			layout="switch"
			control-id="comfort-high-contrast"
			:label="t(key('highContrastLabel'))"
			:help="t(key('highContrastHelp'))"
			:changed="isChanged('highContrast')"
			@reset="reset('highContrast')"
		>
			<UiSwitch
				id="comfort-high-contrast"
				:model-value="comfort.highContrast"
				@update:model-value="set('highContrast', $event)"
			/>
		</PreferencesSettingRow>
		<PreferencesSettingRow
			layout="switch"
			control-id="comfort-reduce-motion"
			:label="t(key('reduceMotionLabel'))"
			:help="t(key('reduceMotionHelp'))"
			:changed="isChanged('reduceMotion')"
			@reset="reset('reduceMotion')"
		>
			<UiSwitch
				id="comfort-reduce-motion"
				:model-value="comfort.reduceMotion"
				@update:model-value="set('reduceMotion', $event)"
			/>
		</PreferencesSettingRow>
	</section>
</template>
