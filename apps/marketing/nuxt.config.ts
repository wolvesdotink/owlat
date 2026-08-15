import tailwindcss from '@tailwindcss/vite';
import type { PluginOption } from 'vite';

// Single-sourced so the canonical site URL, the schema.org identity and the
// i18n `baseUrl` (which is what makes the hreflang alternates absolute) cannot
// drift apart.
const SITE_URL = 'https://owlat.app';

export default defineNuxtConfig({
	extends: ['../../packages/ui'],

	compatibilityDate: '2025-01-16',
	devtools: { enabled: true },

	future: {
		compatibilityVersion: 4,
	},

	// @nuxtjs/i18n is registered first so the SEO modules (sitemap, robots,
	// og-image) see the locale list while they set themselves up and emit
	// per-locale entries.
	modules: ['@nuxtjs/i18n', '@nuxtjs/seo', '@nuxtjs/color-mode', '@nuxt/fonts'],

	i18n: {
		defaultLocale: 'en',
		// `prefix_except_default`: English keeps every URL it has today
		// (https://owlat.app/, /waitlist) and German lives under /de/. Changing the
		// English paths would drop the site's existing search ranking and break
		// links printed in the README, the docs and the desktop app.
		strategy: 'prefix_except_default',
		// Message files live in i18n/locales/ (the module's `restructureDir`) and
		// are loaded on demand — a visitor downloads one catalog, not both.
		locales: [
			{ code: 'en', language: 'en-US', name: 'English', file: 'en.json' },
			{ code: 'de', language: 'de-DE', name: 'Deutsch', file: 'de.json' },
		],
		// Absolute base for the `hreflang` alternates and the canonical link that
		// `useLocaleHead()` (app.vue) writes.
		baseUrl: SITE_URL,
		// Deliberately off: the language is chosen by the visitor through the
		// header switcher, and search engines are pointed at the right variant by
		// the hreflang alternates. Auto-redirecting on `Accept-Language` would
		// bounce a German-configured browser away from a link that was explicitly
		// shared as the English page.
		detectBrowserLanguage: false,
	},

	fonts: {
		// Variable wght axis required: the design system's weight-based emphasis
		// uses intermediate instances (450/550) that a static 400/500/600/700
		// subset would snap to the nearest hundred.
		families: [{ name: 'Figtree', weights: ['300 900'] }],
	},

	site: {
		url: SITE_URL,
		name: 'Owlat',
		// Site-level fallback only. Every page sets a localized description through
		// `useSeoMeta` (with getters), which wins over this one.
		description:
			'Campaigns, automations, transactional sends, and audience operations from one platform. Backed by Convex and powered by AWS SES.',
		defaultLocale: 'en',
	},

	app: {
		head: {
			// No `htmlAttrs.lang` here: `useLocaleHead()` in app.vue writes `lang`
			// (and `dir`) from the active locale, so a pinned value would either be
			// overwritten or, worse, label the German page as English.
			viewport: 'width=device-width, initial-scale=1, viewport-fit=cover',
			link: [{ rel: 'icon', type: 'image/svg+xml', href: '/favicon.svg' }],
		},
	},

	ogImage: {
		enabled: true,
		defaults: {
			cacheMaxAgeSeconds: 60 * 60 * 24 * 7,
		},
	},

	schemaOrg: {
		identity: {
			type: 'Organization',
			name: 'Owlat',
			url: SITE_URL,
			logo: `${SITE_URL}/logo.svg`,
		},
	},

	colorMode: {
		classSuffix: '',
		preference: 'light',
		fallback: 'light',
		storageKey: 'owlat-marketing-theme',
	},

	typescript: {
		strict: true,
		typeCheck: false,
	},

	css: ['~/assets/css/main.css'],

	runtimeConfig: {
		public: {
			// HTTPS endpoint to POST waitlist signups to.
			// Leave blank in local/static preview — form optimistically succeeds.
			// In production, point this at the nest-api waitlist HTTP route
			// (e.g. https://nest-api.owlat.app/waitlist-signup).
			waitlistEndpoint: process.env.NUXT_PUBLIC_WAITLIST_ENDPOINT || '',
		},
	},

	vite: {
		plugins: [tailwindcss() as PluginOption],
	},
});
