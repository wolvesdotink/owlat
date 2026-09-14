import { defineConfig, devices } from '@playwright/test';
import { STORAGE_STATE } from './storage-state';

export default defineConfig({
	testDir: './tests',
	// Tests run in declaration order, one at a time (see `workers` above). The
	// whole suite shares ONE backend instance and one seeded owner, so letting
	// tests interleave buys minutes and costs determinism — several selectors
	// depend on whether a list is empty, which a sibling test decides.
	fullyParallel: false,
	forbidOnly: !!process.env['CI'],
	retries: process.env['CI'] ? 1 : 0,
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
		trace: 'on-first-retry',
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
		command: process.env['CI'] ? 'bun run build && bun run preview' : 'bun run dev',
		url: 'http://localhost:3000',
		reuseExistingServer: !process.env['CI'],
		timeout: process.env['CI'] ? 600_000 : 120_000,
	},
});
