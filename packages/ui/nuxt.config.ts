// Layer-level message catalogs (`ui.*`), inherited by every app that
// `extends` this layer.
//
// How @nuxtjs/i18n v10 picks these up (dist/module.mjs → `createContext` /
// `applyLayerOptions`): the module walks `nuxt.options._layers`, reads each
// layer's own `i18n` config key, resolves that layer's message directory as
// `<layerRootDir>/<restructureDir ?? 'i18n'>/<langDir ?? 'locales'>` — i.e.
// `packages/ui/i18n/locales/` — and merges the resulting per-locale file lists
// (`mergeConfigLocales`) with the LAYER's file first and the APP's file last,
// so an app can override any `ui.*` message by redeclaring the key in its own
// catalog.
//
// The module itself is NOT listed in `modules` here: it is installed by the
// consuming apps (web, marketing, docs), and listing it would make this layer
// unusable by an app that has not adopted i18n yet. A layer only has to
// contribute this config key — which is also why the layer must never assume
// the module is present at runtime (see composables/useUiI18n.ts).
//
// Assembled as a plain object rather than written inline: `NuxtConfig` only
// gains the `i18n` key from @nuxtjs/i18n's type augmentation, which this
// package does not install, and TypeScript's excess-property check applies to
// fresh object literals only. That keeps this honest without a `@ts-expect-error`
// that would itself start failing the day the module does land here.
const config = {
	modules: ['@nuxtjs/color-mode'],

	i18n: {
		locales: [
			{ code: 'en', language: 'en-US', name: 'English', file: 'en.json' },
			{ code: 'de', language: 'de-DE', name: 'Deutsch', file: 'de.json' },
		],
	},
};

export default defineNuxtConfig(config);
