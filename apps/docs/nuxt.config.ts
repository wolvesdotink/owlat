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

	modules: [
		'@nuxt/content',
		'@nuxtjs/color-mode',
		'@nuxt/fonts',
		'@nuxtjs/seo',
	],

	site: {
		url: 'https://docs.owlat.app',
		name: 'Owlat Docs',
		description:
			'Product guides, API reference, and developer docs for Owlat.',
		defaultLocale: 'en',
	},

	app: {
		head: {
			htmlAttrs: { lang: 'en' },
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
		fallback: 'dark',
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
