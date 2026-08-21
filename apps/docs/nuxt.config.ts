import tailwindcss from '@tailwindcss/vite';
import type { PluginOption } from 'vite';
import type { ModuleOptions } from 'nuxt-og-image';

export default defineNuxtConfig({
	extends: ['../../packages/ui'],

	compatibilityDate: '2025-01-16',
	devtools: { enabled: true },

	future: {
		compatibilityVersion: 4,
	},

	modules: ['@nuxt/content', '@nuxtjs/color-mode', '@nuxt/fonts', '@nuxtjs/seo', '@nuxtjs/i18n'],

	i18n: {
		defaultLocale: 'en',
		// `prefix_except_default`: English keeps the URLs this site has always
		// published (`/guide/quick-start`), German lives under `/de/…`. Every
		// content query strips that segment again before hitting the collection —
		// see `app/composables/useDocsContent.ts`.
		strategy: 'prefix_except_default',
		// Absolute base for the hreflang alternates emitted by `useLocaleHead()`
		// in `app.vue`; without it the alternates would be relative and ignored.
		baseUrl: 'https://docs.owlat.app',
		// Message files live in i18n/locales/ (the module's `restructureDir`) and
		// are lazy-loaded — a visitor downloads only the catalog they are shown.
		locales: [
			{ code: 'en', language: 'en-US', name: 'English', file: 'en.json' },
			{ code: 'de', language: 'de-DE', name: 'Deutsch', file: 'de.json' },
		],
		// Detection stays off: the language switcher in the header is the only
		// thing that moves a reader between locales, so a shared/pasted `/de/…`
		// link always renders German and a bare link always renders English.
		// German content lands page by page, and an auto-switched visitor would
		// otherwise be bounced into a locale whose page is still an English
		// fallback.
		detectBrowserLanguage: false,
	},

	fonts: {
		// Variable wght axis required: the design system's weight-based emphasis
		// uses intermediate instances (450/550) that a static 400/500/600/700
		// subset would snap to the nearest hundred.
		families: [{ name: 'Figtree', weights: ['300 900'] }],
	},

	site: {
		url: 'https://docs.owlat.app',
		name: 'Owlat Docs',
		description: 'Product guides, API reference, and developer docs for Owlat.',
		defaultLocale: 'en',
	},

	app: {
		head: {
			// No `htmlAttrs.lang` here on purpose: a value set in nuxt.config wins
			// over the runtime one, which would pin every `/de/…` page to `lang="en"`.
			// `useLocaleHead()` in `app.vue` sets it from the active locale.
			viewport: 'width=device-width, initial-scale=1, viewport-fit=cover',
			link: [{ rel: 'icon', type: 'image/svg+xml', href: '/logo.svg' }],
		},
	},

	ogImage: {
		// nuxt-og-image's `defaults` type omits `component`, but it is honored
		// at runtime; boundary-cast keeps it without resorting to `any`.
		defaults: { component: 'Docs' } as unknown as ModuleOptions['defaults'],
	},

	colorMode: {
		classSuffix: '',
		preference: 'system',
		fallback: 'light',
		storageKey: 'owlat-theme',
	},

	content: {
		build: {
			markdown: {
				highlight: {
					theme: {
						default: 'github-light',
						dark: 'github-dark-dimmed',
					},
				},
			},
		},
	},

	typescript: {
		strict: true,
		typeCheck: false,
	},

	css: ['~/assets/css/main.css', '~/assets/css/prose.css'],

	vite: {
		plugins: [tailwindcss() as PluginOption],
	},
});
