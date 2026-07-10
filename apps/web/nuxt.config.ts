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

	fonts: {
		// Variable wght axis required: the design system's weight-based emphasis
		// uses intermediate instances (450/550) that a static 400/500/600/700
		// subset would snap to the nearest hundred.
		families: [{ name: 'Instrument Sans', weights: ['400 700'] }],
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

		// IA restructure (part 2): deliverability is promoted out of the hidden
		// Settings → Technical hub into its own first-class "Delivery" section at
		// /dashboard/delivery/*. Redirect the old settings paths so bookmarks and
		// deep links keep working; splat forwarding preserves trailing paths.
		// (settings/api stays under Settings — it's app-level and only cross-linked
		// from here. settings/blocklist re-homes under Audience; see below.)
		'/dashboard/settings/reputation': { redirect: '/dashboard/delivery' },
		'/dashboard/settings/domains': { redirect: '/dashboard/delivery/domains' },
		'/dashboard/settings/domains/**': { redirect: '/dashboard/delivery/domains/**' },
		'/dashboard/settings/provider-routing': { redirect: '/dashboard/delivery/provider-routing' },
		'/dashboard/settings/webhooks': { redirect: '/dashboard/delivery/webhooks' },
		'/dashboard/settings/delivery': { redirect: '/dashboard/delivery/config' },
		// Technical hub dissolved: its non-delivery cards re-home under Settings.
		'/dashboard/settings/technical': { redirect: '/dashboard/settings' },
		// Blocklist re-homed as "Suppressions" under Audience (it is audience data,
		// not delivery config). Redirect the old Settings path so bookmarks work.
		'/dashboard/settings/blocklist': { redirect: '/dashboard/audience/suppressions' },
	},

	icon: {
		serverBundle: 'local',
	},

	app: {
		head: {
			// Declare the document language so assistive tech can determine it.
			// With ssr:false the shipped <html> would otherwise carry no lang (WCAG 3.1.1).
			htmlAttrs: { lang: 'en' },
			viewport: 'width=device-width, initial-scale=1, viewport-fit=cover',
			link: [{ rel: 'icon', type: 'image/svg+xml', href: '/favicon.svg' }],
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
