import { watch } from 'vue';
import { bindAppLocale } from '~/utils/formatters';

/**
 * Point `utils/formatters.ts` at the language the app is actually rendering in.
 *
 * Those formatters defaulted to `locale = 'en-US'` and ~160 of their call sites
 * took the default, so a German member read German copy around American dates,
 * American digit grouping and a percent sign glued on without the space German
 * requires. That is not a defect at any one call site — it is a defect in a
 * default, and a default can only be fixed in one place.
 *
 * `useFormat()` is the front door for new code and needs none of this; this
 * plugin is what makes the call sites that predate it correct TODAY, rather
 * than after a 200-file migration. It re-binds on every language change, so
 * switching the picker re-renders dates in the new locale instead of waiting
 * for a reload.
 *
 * Client-only: `ssr: false`, and there is no per-request locale to keep apart.
 */
export default defineNuxtPlugin((nuxtApp) => {
	const i18n = nuxtApp.$i18n as {
		locale: { value: string };
		t: (key: string) => string;
	};

	watch(
		() => i18n.locale.value,
		(locale) => {
			bindAppLocale(locale, {
				never: i18n.t('shared.format.never'),
				invalidDate: i18n.t('shared.format.invalidDate'),
				invalidTime: i18n.t('shared.format.invalidTime'),
			});
		},
		{ immediate: true }
	);
});
