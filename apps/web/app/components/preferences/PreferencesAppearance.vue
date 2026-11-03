<script setup lang="ts">
import { THEME_DEFAULT, type ThemeOption } from '~/composables/useAppTheme';
import SettingsResetToDefault from '~/components/settings/ResetToDefault.vue';
import { MonitorIcon, MoonIcon, SunIcon, WindowIcon, type IconComponent } from '@coolicons/vue';

const { t } = useI18n();
const { isDesktop } = useDesktopContext();
const { themePreference, setTheme } = useAppTheme();
const themeOptions = computed<
	Array<{
		value: ThemeOption;
		label: string;
		icon: IconComponent;
		description: string;
	}>
>(() => [
	{
		value: 'light',
		label: t('components.preferences.preferencesAppearance.light.label'),
		icon: SunIcon,
		description: t('components.preferences.preferencesAppearance.light.description'),
	},
	{
		value: 'dark',
		label: t('components.preferences.preferencesAppearance.dark.label'),
		icon: MoonIcon,
		description: t('components.preferences.preferencesAppearance.dark.description'),
	},
	{
		value: 'system',
		label: t('components.preferences.preferencesAppearance.system.label'),
		icon: MonitorIcon,
		description: t('components.preferences.preferencesAppearance.system.description'),
	},
]);
</script>

<template>
	<section class="card mb-6">
		<div class="mb-4">
			<div class="flex items-center gap-2">
				<h2 class="font-semibold text-text-primary">
					{{ t('components.preferences.preferencesAppearance.title') }}
				</h2>
				<SettingsResetToDefault
					:changed="themePreference !== THEME_DEFAULT"
					:label="t('components.preferences.preferencesAppearance.title')"
					@reset="setTheme(THEME_DEFAULT)"
				/>
			</div>
			<p class="text-sm text-text-secondary">
				{{ t('components.preferences.preferencesAppearance.subtitle') }}
			</p>
		</div>
		<!--
			Toggle buttons in a labelled group, exactly like LanguagePicker one card
			down: `aria-pressed` is what states the selection to a screen reader.
			Without it the three cards announce as three plain buttons and the
			active theme is carried by the border colour alone — invisible to
			anyone not looking at it.
		-->
		<div
			role="group"
			:aria-label="t('components.preferences.preferencesAppearance.groupLabel')"
			class="grid grid-cols-3 gap-3"
		>
			<button
				v-for="option in themeOptions"
				:key="option.value"
				type="button"
				:aria-pressed="themePreference === option.value"
				:class="[
					'rounded-xl border p-3 text-left transition-colors',
					themePreference === option.value
						? 'border-brand bg-brand-subtle'
						: 'border-border-subtle hover:border-border-strong',
				]"
				@click="setTheme(option.value)"
			>
				<component :is="option.icon" class="w-5 h-5 text-brand" />
				<span class="mt-2 block text-sm font-medium text-text-primary">{{ option.label }}</span>
				<span class="block text-xs text-text-tertiary">{{ option.description }}</span>
			</button>
		</div>
		<NuxtLink
			v-if="isDesktop"
			to="/dashboard/preferences/device"
			class="mt-4 inline-flex items-center gap-1.5 text-sm text-brand hover:underline"
		>
			<WindowIcon class="w-4 h-4" />
			{{ t('components.preferences.preferencesAppearance.deviceSettings') }}
		</NuxtLink>
	</section>
</template>
