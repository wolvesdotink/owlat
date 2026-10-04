import { defineConfig, devices } from '@playwright/test';
import { STORAGE_STATE } from './storage-state';

/**
 * No traces in CI. The report is uploaded as an artifact of a public
 * repository, and a trace records request headers and response bodies: the
 * seeded owner's session cookie, the Convex JWT and the test deployment's URLs,
 * which are repository secrets. Nothing can strip all of that from a trace
 * reliably (the URL is in every request and in the app bundle the trace keeps),
 * so CI does not record one. The setup project attaches a redacted browser
 * console and network log instead (auth.setup.ts), and the scan before upload
 * refuses any trace archive that still gets in (scan-report-secrets.ts).
 *
 * Locally the trace stays on: the report never leaves the machine.
 */
const CI = !!process.env['CI'];

export default defineConfig({
	testDir: './tests',
	// Tests run in declaration order, one at a time (see `workers` above). The
	// whole suite shares ONE backend instance and one seeded owner, so letting
	// tests interleave buys minutes and costs determinism — several selectors
	// depend on whether a list is empty, which a sibling test decides.
	fullyParallel: false,
	forbidOnly: CI,
	retries: CI ? 1 : 0,
	// ONE worker. Every test drives the same single Convex deployment — a 2-vCPU
	// box — so parallel workers contend on the backend rather than on the runner:
	// at two workers the sender query and a contact create both blew their
	// budgets while passing comfortably in serial. The whole suite is ~3 minutes
	// serially, which is a cheap price for a deterministic answer.
	workers: 1,
	reporter: 'html',

	timeout: 45_000,
	expect: {
		timeout: 10_000,
	},

	use: {
		baseURL: 'http://localhost:3000',
		trace: CI ? 'off' : 'on-first-retry',
		screenshot: 'only-on-failure',
	},

	projects: [
		{
			name: 'setup',
			testDir: '.',
			testMatch: /auth\.setup\.ts/,
			// No retries: /seed/admin is one-shot (it refuses once any account
			// exists), so a retry cannot re-bootstrap. A second attempt would
			// either sign in — masking whatever broke the first — or fail with a
			// seed error that says nothing about the real cause.
			retries: 0,
			// So the global `on-first-retry` would never record a trace here, and a
			// setup failure skips every spec that depends on it. Locally, keep one
			// whenever it fails: network, console and DOM are what tell a slow
			// deployment from a Convex client that never re-authenticated (#1203).
			// In CI the redacted console and network log stand in for it (see
			// the comment on `CI` above).
			use: { trace: CI ? 'off' : 'retain-on-failure' },
		},
		{
			// No `dependencies` and no storage state: this one answers "does the
			// app run at all", so it must not be skipped by a failing auth setup —
			// that is precisely the case where its answer matters most.
			name: 'shell',
			testMatch: /csp-boot\.spec\.ts/,
		},
		{
			name: 'chromium',
			testIgnore: /csp-boot\.spec\.ts/,
			use: {
				...devices['Desktop Chrome'],
				storageState: STORAGE_STATE,
			},
			dependencies: ['setup'],
		},
	],

	// Locally: the dev server, so a spec can be re-run against an edit.
	//
	// In CI: a production build, served by `nuxt preview`. `nuxt dev` compiles
	// the route graph on demand, and with `ssr: false` the browser sits on the
	// SPA loading template until that finishes — on a 2-core runner the first
	// navigation blew the 45s test budget while Vite was still working, which is
	// what failed the first real run of this suite (the page snapshot was
	// `status "Loading Owlat"`). Building up front moves that cost into the
	// webServer's own (generous) startup window, where it is not racing a test
	// timeout, and has the browser drive the bundle that actually ships.
	//
	// The build bakes `NUXT_PUBLIC_*` into the client bundle (`ssr: false`), so
	// the deployment URLs have to be in the environment for THIS command, not
	// merely for the test run — .github/workflows/e2e.yml puts them there.
	webServer: {
		command: CI ? 'bun run build && bun run preview' : 'bun run dev',
		url: 'http://localhost:3000',
		reuseExistingServer: !CI,
		timeout: CI ? 600_000 : 120_000,
	},
});
