import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
	testDir: './tests',
	fullyParallel: true,
	forbidOnly: !!process.env['CI'],
	retries: process.env['CI'] ? 1 : 0,
	workers: undefined,
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
			// No retries: registerTestUser() mints a new address per call, and
			// the instance only grants ONE bootstrap signup (the rest is
			// invite-only), so a retry after a half-succeeded registration
			// registers a different user and is refused. Fail the run instead.
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
				storageState: '.auth/user.json',
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
