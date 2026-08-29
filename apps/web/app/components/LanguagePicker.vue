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
 *
 * The choice is ALSO written to the account (`userProfiles.locale`), which the
 * cookie cannot stand in for anywhere: a cookie does not exist on a device this
 * person has not opened yet, and it does not exist at all for a system EMAIL,
 * which the backend composes with no request behind it. Someone who set the
 * product to German and then got their account-deletion confirmation in English
 * was reading the gap this closes.
 */
import { api } from '@owlat/api';

const { t, locale, locales, setLocale } = useI18n();
const { isAuthenticated } = useAuth();
const client = useConvex();

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
		// Cookie first: it is what the next page load reads, and it must land
		// even if the account write cannot.
		await setLocale(code);
		await rememberOnAccount(code);
	} finally {
		isSwitching.value = false;
	}
}

/**
 * Echo the choice onto the account. Deliberately NOT through
 * `useBackendOperation`: by the time this runs the language has already
 * changed, so there is nothing for a red toast to tell anyone — a fallback for
 * the next device failed to save, and the correct treatment is silence plus a
 * retry the next time the picker is touched. Skipped entirely when signed out
 * (the setup and auth screens mount this picker too), where the mutation would
 * only 403.
 */
async function rememberOnAccount(code: AppLocale) {
	if (!isAuthenticated.value || !client) return;
	try {
		await client.mutation(api.auth.userProfiles.setLocale, { locale: code });
	} catch {
		// The cookie already holds the choice; this is the durable copy.
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
