import tailwindcss from '@tailwindcss/vite';
import type { PluginOption } from 'vite';

// Local default endpoints, single-sourced so the CSP connect-src and the
// runtimeConfig fallbacks (and the PostHog plugin) can't drift.
const POSTHOG_DEFAULT_HOST = 'https://eu.i.posthog.com';
const DEFAULT_SITE_URL = 'http://localhost:3000';

// https://nuxt.com/docs/api/configuration/nuxt-config
export default defineNuxtConfig({
	ssr: false,
	extends: ['../../packages/ui'],

	compatibilityDate: '2025-01-16',
	sourcemap: { server: false, client: false },
	devtools: { enabled: true },

	future: {
		compatibilityVersion: 4,
	},

	nitro: {
		// Exclude papaparse from the server bundle — it's client-only and its
		// blob URL code breaks Rollup's parser during the Nitro build.
		externals: {
			inline: [],
		},
		rollupConfig: {
			external: ['papaparse'],
		},
	},

	modules: ['nuxt-security', '@nuxtjs/color-mode', '@nuxt/fonts', '@nuxt/icon'],

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
				// covered by 'self' / 'https:'. If your build emits an inline
				// script (e.g. color-mode FOUC prevention), enable
				// nuxt-security nonce mode or move it to a static file.
				// Desktop builds keep 'unsafe-inline': the dev SPA shell boots via
				// inline scripts (WebKit blocks them without it → blank window), and
				// the packaged app's enforcement boundary is tauri.conf.json's CSP,
				// which allows inline scripts anyway.
				'style-src': ["'self'", 'https:', "'unsafe-inline'"],
				'script-src':
					process.env['OWLAT_DESKTOP'] === 'true'
						? ["'self'", 'https:', "'unsafe-inline'"]
						: ["'self'", 'https:'],
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
							(process.env['NUXT_PUBLIC_CONVEX_URL'] || process.env['CONVEX_URL'])?.replace(/^http/, 'ws'),
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

	routeRules: {},

	icon: {
		serverBundle: 'local',
	},

	app: {
		head: {
			viewport: 'width=device-width, initial-scale=1, viewport-fit=cover',
			link: [{ rel: 'icon', type: 'image/svg+xml', href: '/favicon.svg' }],
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
