<script setup lang="ts">
/**
 * The interface-language control.
 *
 * Reads the locale list from the i18n module rather than a hardcoded array, so
 * registering a locale in `nuxt.config` is the only step a new language needs —
 * `apps/docs → UI localization` promises exactly that.
 *
 * Switching goes through `setLocale`, which loads the locale's catalog, swaps
 * the active locale and writes the `owlat-locale` cookie. That cookie is what
 * makes the choice outlive the tab: with `strategy: 'no_prefix'` the URL carries
 * no locale, so browser detection would otherwise win back the next page load
 * for anyone whose browser language is not the one they picked.
 */
const { t, locale, locales, setLocale } = useI18n();

/** The module's own union of registered codes — `setLocale` accepts nothing else. */
type AppLocale = typeof locale.value;

// Spread first: the module types `locales` as `Locale[] | LocaleObject[]`, and
// mapping a union of array types directly is not callable in TypeScript.
const options = computed(() =>
	[...locales.value].map((entry) =>
		typeof entry === 'string'
			? { code: entry as AppLocale, name: entry, language: entry }
			: { code: entry.code, name: entry.name ?? entry.code, language: entry.language ?? entry.code }
	)
);

/** Loading the target catalog is a network hop; a second click mid-flight would race it. */
const isSwitching = ref(false);

async function choose(code: AppLocale) {
	if (isSwitching.value || code === locale.value) return;
	isSwitching.value = true;
	try {
		await setLocale(code);
	} finally {
		isSwitching.value = false;
	}
}
</script>

<template>
	<!--
		Toggle buttons rather than a <select>: the set is small, the active one has
		to be visible at a glance, and `aria-pressed` states it without a live
		region. Each label is marked with its OWN `lang`, so a screen reader
		announces "Deutsch" in German while the surrounding page is still English.
	-->
	<div
		role="group"
		:aria-label="t('components.languagePicker.ariaLabel')"
		class="grid grid-cols-3 gap-3 max-sm:grid-cols-2"
	>
		<button
			v-for="option in options"
			:key="option.code"
			type="button"
			:aria-pressed="option.code === locale"
			:disabled="isSwitching"
			:class="[
				'rounded-xl border p-3 text-left transition-colors disabled:opacity-60',
				option.code === locale
					? 'border-brand bg-brand-subtle'
					: 'border-border-subtle hover:border-border-strong',
			]"
			@click="choose(option.code)"
		>
			<Icon
				:name="option.code === locale ? 'lucide:check' : 'lucide:languages'"
				class="w-5 h-5 text-brand"
			/>
			<span :lang="option.language" class="mt-2 block text-sm font-medium text-text-primary">{{
				option.name
			}}</span>
			<span class="block text-xs text-text-tertiary">{{ option.language }}</span>
		</button>
	</div>
</template>
