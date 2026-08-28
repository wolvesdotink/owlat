import { fileURLToPath } from 'node:url';
import tailwindcss from '@tailwindcss/vite';
import type { PluginOption } from 'vite';

// Local default endpoints, single-sourced so the CSP connect-src and the
// runtimeConfig fallbacks (and the PostHog plugin) can't drift.
const POSTHOG_DEFAULT_HOST = 'https://eu.i.posthog.com';
const DEFAULT_SITE_URL = 'http://localhost:3000';

// https://nuxt.com/docs/api/configuration/nuxt-config
export default defineNuxtConfig({
	ssr: false,
	// With ssr:false a cold launch is a blank window until the bundle + first
	// subscription resolve. This FF-styled splash (app/spa-loading-template.html)
	// paints the Owlat mark on the first frame instead. Fully self-contained
	// (inline CSS/SVG, no external assets — the CSP forbids them); Nuxt removes it
	// once the app mounts.
	// Resolved relative to srcDir (app/, under compatibilityVersion 4).
	spaLoadingTemplate: 'spa-loading-template.html',
	extends: ['../../packages/ui'],

	compatibilityDate: '2025-01-16',
	sourcemap: { server: false, client: false },
	devtools: { enabled: true },

	future: {
		compatibilityVersion: 4,
	},

	nitro: {
		// The offline app shell service worker (service-worker/sw.js → /sw.js).
		// It is NOT in public/ so that this one line can keep it out of a build:
		// the desktop bundle (`generate:desktop`) is served from a Tauri custom
		// scheme where service workers do not apply, so it must never contain the
		// file — and the client plugin refuses to register there anyway.
		// `maxAge: 0` is deliberate: a long-cached worker script is a deploy that
		// can never be picked up.
		publicAssets:
			process.env['OWLAT_DESKTOP'] === 'true'
				? []
				: [{ dir: fileURLToPath(new URL('./service-worker', import.meta.url)), maxAge: 0 }],
		// Exclude papaparse from the server bundle — it's client-only and its
		// blob URL code breaks Rollup's parser during the Nitro build.
		externals: {
			inline: [],
		},
		rollupConfig: {
			external: ['papaparse'],
		},
	},

	modules: ['nuxt-security', '@nuxtjs/color-mode', '@nuxt/fonts', '@nuxt/icon', '@nuxtjs/i18n'],

	i18n: {
		defaultLocale: 'en',
		// `no_prefix`: the locale never appears in the URL. Every path in this app
		// is either a dashboard route or a token link printed inside an already-sent
		// email (/unsubscribe?token=…), so a locale segment would break live links
		// and would have to be mirrored in every `routeRules` redirect above.
		strategy: 'no_prefix',
		// Message files live in i18n/locales/ (the module's `restructureDir`) and are
		// loaded on demand — the default locale's bundle is the only one a visitor
		// ever downloads.
		locales: [
			{ code: 'en', language: 'en-US', name: 'English', file: 'en.json' },
			{ code: 'de', language: 'de-DE', name: 'Deutsch', file: 'de.json' },
		],
		// The whole UI is extracted, so a first-time visitor can safely be served
		// the locale their browser asks for. The cookie is what makes the choice
		// stick: with `no_prefix` the URL carries no locale, so without it every
		// reload would re-run detection and undo the picker
		// (components/LanguagePicker.vue) for anyone whose browser disagrees with
		// them. `owlat-locale` is read back by that picker's `setLocale`.
		detectBrowserLanguage: { useCookie: true, cookieKey: 'owlat-locale' },
	},

	fonts: {
		// Variable wght axis required: the design system's weight-based emphasis
		// uses intermediate instances (450/550) that a static 400/500/600/700
		// subset would snap to the nearest hundred.
		families: [{ name: 'Figtree', weights: ['300 900'] }],
	},

	security: {
		headers: {
			contentSecurityPolicy: {
				'base-uri': ["'none'"],
				'font-src': ["'self'", 'https:', 'data:'],
				'form-action': ["'self'"],
				'img-src': ["'self'", 'data:', 'https:'],
				'object-src': ["'none'"],
				'script-src-attr': ["'none'"],
				// 'unsafe-inline' kept on style-src because email-builder
				// previews and inline component styles legitimately need it.
				// Dropped from script-src to remove the in-page XSS escalation
				// path. Bundled Nuxt scripts load via `<script src>` and are
				// covered by 'self' — no script is ever fetched from a third
				// party (icons are bundled via @nuxt/icon's clientBundle, fonts
				// ride font-src). Keeping 'https:' here would let an injected
				// <script src="https://attacker…"> through and void the policy.
				// If your build emits an inline script (e.g. color-mode FOUC
				// prevention), enable nuxt-security nonce mode or move it to a
				// static file.
				// Desktop builds keep 'unsafe-inline': the dev SPA shell boots via
				// inline scripts (WebKit blocks them without it → blank window), and
				// the packaged app's enforcement boundary is tauri.conf.json's CSP,
				// which allows inline scripts anyway.
				'style-src': ["'self'", 'https:', "'unsafe-inline'"],
				// The offline app shell worker (/sw.js). Same value on both branches
				// — it is only ever registered from this origin, and the desktop
				// build ships no worker at all. Stated explicitly rather than left to
				// the worker-src → script-src fallback, so tightening script-src (or
				// adding a default-src) can never silently stop the worker from
				// registering, which would degrade to a blank offline window.
				'worker-src': ["'self'"],
				'script-src':
					process.env['OWLAT_DESKTOP'] === 'true'
						? ["'self'", 'https:', "'unsafe-inline'"]
						: ["'self'"],
				// Every iframe in the app is srcdoc-based (email previews, postbox
				// bodies, archives, share pages — all sanitized + sandboxed), so
				// remote frame loads are never legitimate. Local-scheme frames
				// (about:srcdoc) are exempt from frame-src and inherit this
				// document's policy, so this only bars future external embeds.
				'frame-src': ["'none'"],
				// Desktop builds (`OWLAT_DESKTOP=true`, produced by `generate:desktop`)
				// connect to arbitrary self-hosted instances chosen at runtime, so the
				// build-time single-URL allowlist is wrong for them — allow any https/wss
				// target (plus localhost for dev instances). The packaged Tauri webview's
				// own CSP (tauri.conf.json) is the real enforcement boundary; this keeps
				// any SSG-injected meta CSP from blocking runtime workspaces.
				'connect-src': (process.env['OWLAT_DESKTOP'] === 'true'
					? [
							"'self'",
							'https:',
							'wss:',
							'http://localhost:*',
							'ws://localhost:*',
							// CSP host matching is literal — `localhost` does not cover the
							// loopback IP, and the local dev stack advertises its Convex
							// backend as 127.0.0.1 (apps/api/.env.local), so the webview's
							// Convex websocket (ws://127.0.0.1:3210) needs its own entries.
							'http://127.0.0.1:*',
							'ws://127.0.0.1:*',
							// Tauri IPC: WKWebView fetches the `ipc:` scheme on macOS;
							// Windows/Linux route it through http://ipc.localhost.
							'ipc:',
							'http://ipc.localhost',
						]
					: [
							"'self'",
							'https://api.iconify.design',
							process.env['NUXT_PUBLIC_CONVEX_URL'] || process.env['CONVEX_URL'],
							// Convex uses WebSocket — add explicit ws(s):// so browsers that don't
							// auto-match http→ws per CSP3 still allow the connection.
							(process.env['NUXT_PUBLIC_CONVEX_URL'] || process.env['CONVEX_URL'])?.replace(
								/^http/,
								'ws'
							),
							process.env['NUXT_PUBLIC_CONVEX_SITE_URL'] || process.env['CONVEX_SITE_URL'],
							process.env['NUXT_PUBLIC_POSTHOG_HOST'] || POSTHOG_DEFAULT_HOST,
						]
				).filter(Boolean) as string[],
				// nuxt-security defaults this to true. The desktop webview (WebKit)
				// honours it even for http://localhost — `tauri dev` assets get
				// force-upgraded to https:// and the app renders a blank window —
				// so it's disabled for desktop builds/dev. The packaged app's real
				// CSP boundary is tauri.conf.json.
				'upgrade-insecure-requests': process.env['OWLAT_DESKTOP'] !== 'true',
			},
			crossOriginEmbedderPolicy: 'unsafe-none',
			strictTransportSecurity: {
				maxAge: 31536000,
				includeSubdomains: true,
				preload: true,
			},
			xFrameOptions: 'SAMEORIGIN',
			xContentTypeOptions: 'nosniff',
			referrerPolicy: 'strict-origin-when-cross-origin',
		},

		corsHandler: {
			origin: [
				process.env['NUXT_PUBLIC_SITE_URL'] || DEFAULT_SITE_URL,
				// Desktop app webview origins — needed so a packaged desktop client
				// can reach this instance's public `/api/instance-info` discovery
				// endpoint cross-origin. (Auth itself goes to the Convex site URL and
				// is governed by BetterAuth trustedOrigins, not this handler.)
				'tauri://localhost',
				'https://tauri.localhost',
			].filter(Boolean) as string[],
			methods: ['GET', 'HEAD', 'PUT', 'PATCH', 'POST', 'DELETE'],
			credentials: true,
		},

		// rateLimiter and requestSizeLimiter removed — Workers are stateless,
		// use Cloudflare WAF rate limiting rules instead (configured in dashboard).

		xssValidator: {},

		csrf: true,
	},

	routeRules: {
		// The BetterAuth proxy must be exempt from nuxt-csurf: the better-auth
		// client uses its own fetch, which cannot carry the csrf-token header, so
		// every proxied sign-in/sign-up POST would 403 ("CSRF Token not found").
		// Safe to exempt — BetterAuth applies its own CSRF defense server-side
		// (Origin/Referer must match trustedOrigins on any cookie-bearing POST;
		// see better-auth's originCheckMiddleware), and the proxy forwards the
		// browser's Origin header verbatim.
		'/api/auth/**': { csurf: false },

		// Machine-to-machine control-plane routes authenticate with the
		// X-Instance-Secret header, not the session cookie, so nuxt-csurf's
		// cookie+header pair can never be satisfied and every POST would 403
		// ("CSRF Cookie not found"). Safe to exempt — there is no browser
		// credential to forge: a cross-site attacker without INSTANCE_SECRET is
		// rejected by requireInstanceSecret regardless of CSRF.
		'/api/self-update': { csurf: false },
		'/api/internal/**': { csurf: false },

		// IA restructure: the Mail + Campaigns sidebar sections merged into one
		// "Send" section and the email surfaces moved under /dashboard/send/*.
		// Redirect the old paths so bookmarks and deep links keep working. Splat
		// forwarding preserves the trailing path (e.g. an editor's [id]/edit).
		'/dashboard/mail': { redirect: '/dashboard/send' },
		'/dashboard/mail/**': { redirect: '/dashboard/send/**' },
		'/dashboard/emails/**': { redirect: '/dashboard/send/emails/**' },
		'/dashboard/transactional/**': { redirect: '/dashboard/send/transactional/**' },

		// A/B results folded into each campaign's report (piece c3b). The
		// standalone list is gone; send its old deep link to the command center.
		'/dashboard/campaigns/ab-results': { redirect: '/dashboard/campaigns' },

		// NOTE: pre-release `/dashboard/settings/*` and `/dashboard/delivery/*` URLs
		// intentionally 404 — the app never shipped, so no compatibility redirects
		// are kept. Do not add `/dashboard/admin/**` redirect rules here:
		// those paths are the real pages of the new IA and a rule would shadow them
		// (a `/dashboard/admin/delivery` rule 307'd every hard load of the Delivery
		// hub to a sub-page).
	},

	icon: {
		serverBundle: 'local',
		// The desktop build (`generate:desktop`) is served statically inside the
		// Tauri webview — there is no Nitro server, so the default
		// /api/_nuxt_icon endpoint never exists and every icon request fails.
		// Bundling all statically-referenced icons into the client JS makes them
		// render offline in the desktop app (and skips the fetch on the web too).
		clientBundle: {
			scan: true,
			sizeLimitKb: 512,
		},
	},

	app: {
		head: {
			// No `htmlAttrs.lang` here on purpose: a value set in nuxt.config wins
			// over anything a component writes, so it would pin every page to `en`
			// even after the visitor switches. `useLocaleHead()` in `app/app.vue`
			// sets `lang` from the active locale instead — assistive tech still gets
			// a declared document language (WCAG 3.1.1) on the ssr:false shell,
			// and it is now the right one.
			viewport: 'width=device-width, initial-scale=1, viewport-fit=cover',
			link: [
				{ rel: 'icon', type: 'image/svg+xml', href: '/favicon.svg' },
				// iOS ignores the manifest's icons for "Add to Home Screen" and uses
				// this one (full-bleed: iOS applies its own corner mask).
				{ rel: 'apple-touch-icon', sizes: '180x180', href: '/apple-touch-icon.png' },
				{ rel: 'manifest', href: '/manifest.webmanifest' },
			],
			meta: [
				{ name: 'application-name', content: 'Owlat' },
				// Installability / standalone chrome. `apple-mobile-web-app-capable` is
				// the legacy alias iOS still requires alongside the standard name.
				{ name: 'mobile-web-app-capable', content: 'yes' },
				{ name: 'apple-mobile-web-app-capable', content: 'yes' },
				{ name: 'apple-mobile-web-app-title', content: 'Owlat' },
				{ name: 'apple-mobile-web-app-status-bar-style', content: 'default' },
				// Browser/OS chrome tint per scheme, mirroring --surface-1 in
				// packages/ui/assets/css/{light,dark}.css. `key` is required: unhead
				// dedupes meta by `name` alone, so without it the second theme-color
				// would replace the first instead of sitting beside it.
				{
					key: 'theme-color-light',
					name: 'theme-color',
					content: '#fafafa',
					media: '(prefers-color-scheme: light)',
				},
				{
					key: 'theme-color-dark',
					name: 'theme-color',
					content: '#171717',
					media: '(prefers-color-scheme: dark)',
				},
			],
		},
		// Subtle FF-spring page/layout transitions so client-side navigations read
		// as continuous motion, never a hard cut to a blank pane. `out-in` keeps a
		// single pane moving at a time (styles in assets/css/page-transitions.css;
		// reduced-motion collapses to an instant swap there). The desktop
		// workspace switch reloads the whole document (window.location.assign) and
		// never runs these SPA transitions, so its skeleton handoff is untouched.
		pageTransition: { name: 'page', mode: 'out-in' },
		layoutTransition: { name: 'layout', mode: 'out-in' },
	},

	colorMode: {
		classSuffix: '',
		preference: 'system',
		fallback: 'light',
		storageKey: 'owlat-theme',
	},

	typescript: {
		strict: true,
		// Work around flaky vite-plugin-checker vue-tsc fixture copies (seen with Bun installs).
		// Keep CI/explicit local checking via `nuxt typecheck` or `NUXT_TYPECHECK=true`.
		typeCheck: process.env['NUXT_TYPECHECK'] === 'true',
	},

	imports: {
		// Nuxt only auto-imports the top level of `composables/` by default.
		// Postbox and chat composables live in nested folders and need to be added explicitly.
		dirs: ['composables/postbox', 'composables/chat'],
	},

	css: ['@owlat/email-builder/styles', '@owlat/email-previewer/styles', '~/assets/css/main.css'],

	vite: {
		plugins: [tailwindcss() as PluginOption],
		build: {
			sourcemap: false,
		},
		// Pre-bundle the Tauri modules reached via dynamic import (`@owlat/desktop`'s
		// SSH/dialog bridges). Without this, Vite "discovers" them mid-session — the
		// first click on Connect triggers a re-optimize + full page reload, which
		// wipes the wizard state and looks like a crash in the desktop webview.
		optimizeDeps: {
			include: ['@tauri-apps/api/core', '@tauri-apps/api/path', '@tauri-apps/plugin-dialog'],
		},
	},

	runtimeConfig: {
		convexSiteUrlInternal: process.env['NUXT_CONVEX_SITE_URL_INTERNAL'] || '',
		public: {
			convexUrl: process.env['NUXT_PUBLIC_CONVEX_URL'] || '',
			convexSiteUrl: process.env['NUXT_PUBLIC_CONVEX_SITE_URL'] || '',
			// Optional explicit URL for the Convex admin dashboard (port 6791) shown
			// in the self-host onboarding banner. Empty by default: the dashboard is
			// loopback-bound + SSH-tunnelled on a hardened install, so its address
			// can't be derived reliably. When set, the banner links straight to it;
			// otherwise it derives a best-effort guess the operator can override.
			convexDashboardUrl: process.env['NUXT_PUBLIC_CONVEX_DASHBOARD_URL'] || '',
			siteUrl: process.env['NUXT_PUBLIC_SITE_URL'] || DEFAULT_SITE_URL,
			// True when the bundle is produced by `generate:desktop` for the Tauri
			// app. Gates desktop-only runtime config (workspace picker, cross-domain
			// auth) so the SPA reads its backend from the active workspace at runtime
			// instead of the build-time NUXT_PUBLIC_CONVEX_URL.
			isDesktopBuild: process.env['OWLAT_DESKTOP'] === 'true',
			// Offline app shell kill switch (`NUXT_PUBLIC_OFFLINE_SHELL=false`).
			// ON by default: the service worker only ever caches the SPA shell and
			// content-hashed build assets, and answers navigations network-first.
			// Baked at build time like every other public value in an ssr:false
			// bundle, so flipping it needs a rebuild — and flipping it OFF actively
			// unregisters the worker (app/plugins/service-worker.client.ts).
			offlineShell: process.env['NUXT_PUBLIC_OFFLINE_SHELL'] !== 'false',
			// Deployment mode — 'selfhost' or 'hosted'
			// Drives the onboarding banner, hides hosted-only UI (billing tabs,
			// upgrade prompts), and gates the in-app update feature.
			deploymentMode: process.env['OWLAT_DEPLOYMENT_MODE'] || 'selfhost',
			// First-run setup mode — when true the global setup middleware
			// redirects all routes to /setup/* until the wizard completes.
			setupMode: process.env['OWLAT_SETUP_MODE'] === 'true',
			// Build-time version metadata (for Settings → System)
			owlatVersion: process.env['OWLAT_VERSION'] || 'dev',
			owlatGitSha: process.env['OWLAT_GIT_SHA'] || 'unknown',
			owlatBuildDate: process.env['OWLAT_BUILD_DATE'] || 'unknown',
			// PostHog product analytics
			posthogApiKey: process.env['NUXT_PUBLIC_POSTHOG_API_KEY'] || '',
			posthogHost: process.env['NUXT_PUBLIC_POSTHOG_HOST'] || POSTHOG_DEFAULT_HOST,
			// Legal / company details
			companyName: '',
			companyRepresentative: '',
			companyStreet: '',
			companyPostalCode: '',
			companyCity: '',
			companyCountry: '',
			companyEmail: '',
			companyPhone: '',
		},
	},
});
