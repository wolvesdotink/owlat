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
			name: 'chromium',
			use: {
				...devices['Desktop Chrome'],
				storageState: '.auth/user.json',
			},
			dependencies: ['setup'],
		},
	],

	webServer: {
		command: 'bun run dev',
		url: 'http://localhost:3000',
		reuseExistingServer: !process.env['CI'],
		timeout: 120_000,
	},
});
