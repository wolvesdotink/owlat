<script setup lang="ts">
import type { ThemeOption } from '~/composables/useAppTheme';

const { t } = useI18n();
const { isDesktop } = useDesktopContext();
const { themePreference, setTheme } = useAppTheme();
const themeOptions = computed<
	Array<{
		value: ThemeOption;
		label: string;
		icon: string;
		description: string;
	}>
>(() => [
	{
		value: 'light',
		label: t('components.preferences.preferencesAppearance.light.label'),
		icon: 'lucide:sun',
		description: t('components.preferences.preferencesAppearance.light.description'),
	},
	{
		value: 'dark',
		label: t('components.preferences.preferencesAppearance.dark.label'),
		icon: 'lucide:moon',
		description: t('components.preferences.preferencesAppearance.dark.description'),
	},
	{
		value: 'system',
		label: t('components.preferences.preferencesAppearance.system.label'),
		icon: 'lucide:monitor',
		description: t('components.preferences.preferencesAppearance.system.description'),
	},
]);
</script>

<template>
	<section class="card mb-6">
		<div class="flex items-center justify-between gap-4 mb-4">
			<div>
				<h2 class="font-semibold text-text-primary">
					{{ t('components.preferences.preferencesAppearance.title') }}
				</h2>
				<p class="text-sm text-text-secondary">
					{{ t('components.preferences.preferencesAppearance.subtitle') }}
				</p>
			</div>
			<NuxtLink to="/dashboard/preferences/account" class="text-sm text-brand hover:underline">
				{{ t('components.preferences.preferencesAppearance.accountAndData') }}
			</NuxtLink>
		</div>
		<div class="grid grid-cols-3 gap-3">
			<button
				v-for="option in themeOptions"
				:key="option.value"
				type="button"
				:class="[
					'rounded-xl border p-3 text-left transition-colors',
					themePreference === option.value
						? 'border-brand bg-brand-subtle'
						: 'border-border-subtle hover:border-border-strong',
				]"
				@click="setTheme(option.value)"
			>
				<Icon :name="option.icon" class="w-5 h-5 text-brand" />
				<span class="mt-2 block text-sm font-medium text-text-primary">{{ option.label }}</span>
				<span class="block text-xs text-text-tertiary">{{ option.description }}</span>
			</button>
		</div>
		<NuxtLink
			v-if="isDesktop"
			to="/desktop/settings"
			class="mt-4 inline-flex items-center gap-1.5 text-sm text-brand hover:underline"
		>
			<Icon name="lucide:app-window" class="w-4 h-4" />
			{{ t('components.preferences.preferencesAppearance.deviceSettings') }}
		</NuxtLink>
	</section>
</template>
