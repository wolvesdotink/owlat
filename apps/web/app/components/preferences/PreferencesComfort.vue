<script setup lang="ts">
/**
 * Reading comfort: the app's text size, mail text size and reading width,
 * higher contrast, an in-app "Reduce motion" switch, list density for the Team
 * Inbox, contacts and campaigns, and the zoom kept per sender. Device-local
 * like the theme (composables/useReadingComfort, useSenderZoom), so the card
 * shows for everyone, mail or not, and every change applies at once.
 */
import { useReadingComfort } from '~/composables/useReadingComfort';
import { useSenderZoom } from '~/composables/useSenderZoom';
import PreferencesSettingRow from './PreferencesSettingRow.vue';
import {
	LIST_DENSITY_OPTIONS,
	MAIL_TEXT_SIZE_OPTIONS,
	READING_WIDTH_OPTIONS,
	UI_TEXT_SIZES,
	type ListDensity,
	type MailTextSize,
	type ReadingWidth,
	type UiTextSize,
} from '~/utils/readingComfort';

const { t } = useI18n();
const { comfort, set, reset, isChanged } = useReadingComfort();
const { count: senderZoomCount, clearAll: clearSenderZooms } = useSenderZoom();

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
			control-id="comfort-ui-text-size"
			:label="t(key('uiTextSizeLabel'))"
			:help="t(key('uiTextSizeHelp'))"
			:changed="isChanged('uiTextSize')"
			@reset="reset('uiTextSize')"
		>
			<select
				id="comfort-ui-text-size"
				class="input w-full sm:w-64 shrink-0"
				:value="comfort.uiTextSize"
				@change="set('uiTextSize', Number(selected($event)) as UiTextSize)"
			>
				<option v-for="percent in UI_TEXT_SIZES" :key="percent" :value="percent">
					{{
						percent === 100 ? t(key('uiTextSizeDefault')) : t(key('uiTextSizeOption'), { percent })
					}}
				</option>
			</select>
		</PreferencesSettingRow>
		<PreferencesSettingRow
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
		<!-- Set from the reader; here it can be seen and undone in one go. -->
		<PreferencesSettingRow
			control-id="comfort-sender-zoom"
			:label="t(key('senderZoomLabel'))"
			:help="t(key('senderZoomHelp'))"
			:changed="senderZoomCount > 0"
			@reset="clearSenderZooms()"
		>
			<output id="comfort-sender-zoom" class="text-sm text-text-secondary shrink-0">
				{{ t(key('senderZoomCount'), { count: senderZoomCount }, senderZoomCount) }}
			</output>
		</PreferencesSettingRow>
	</section>
</template>
