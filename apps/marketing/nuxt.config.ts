import tailwindcss from '@tailwindcss/vite';
import type { PluginOption } from 'vite';

export default defineNuxtConfig({
	extends: ['../../packages/ui'],

	compatibilityDate: '2025-01-16',
	devtools: { enabled: true },

	future: {
		compatibilityVersion: 4,
	},

	modules: ['@nuxtjs/seo', '@nuxtjs/color-mode', '@nuxt/fonts'],

	fonts: {
		// Variable wght axis required: the design system's weight-based emphasis
		// uses intermediate instances (450/550) that a static 400/500/600/700
		// subset would snap to the nearest hundred.
		families: [{ name: 'Instrument Sans', weights: ['400 700'] }],
	},

	site: {
		url: 'https://owlat.app',
		name: 'Owlat',
		description:
			'Campaigns, automations, transactional sends, and audience operations from one platform. Backed by Convex and powered by AWS SES.',
		defaultLocale: 'en',
	},

	app: {
		head: {
			htmlAttrs: { lang: 'en' },
			viewport: 'width=device-width, initial-scale=1, viewport-fit=cover',
			link: [{ rel: 'icon', type: 'image/svg+xml', href: '/favicon.svg' }],
			meta: [
				{
					name: 'description',
					content:
						'Campaigns, automations, transactional sends, and audience operations from one platform. Backed by Convex and powered by AWS SES.',
				},
			],
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
			url: 'https://owlat.app',
			logo: 'https://owlat.app/logo.svg',
		},
	},

	colorMode: {
		classSuffix: '',
		preference: 'system',
		fallback: 'dark',
		storageKey: 'owlat-theme',
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
