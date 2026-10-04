import { test as setup, expect } from '@playwright/test';
import { testUser } from './fixtures/test-data';
import { seedAdmin } from './seedAdmin';
import { SETUP_BEFORE_STAMP_MS, WELCOME_STAMP_SETTLE_MS } from './timing';
import { STORAGE_STATE } from './storage-state';
import { describeRequest, redactForReport, testDeployments } from './reportRedaction';

/**
 * The browser console and network activity of the setup run, attached to the
 * report afterwards. CI records no trace (playwright.config.ts), so these are
 * what is left to tell a slow deployment from a client that never
 * authenticated (#1203). Every line is redacted as it is written: the report is
 * public, and the deployment URLs and the Convex JWT must not reach it.
 */
const consoleLines: string[] = [];
const networkLines: string[] = [];

const deployments = testDeployments();

/** Requests worth a line: the app's documents and API calls, not its assets. */
const LOGGED_RESOURCE_TYPES = new Set(['document', 'fetch', 'xhr']);

setup.afterEach(async () => {
	// Attached on success too: a passing run's console is the baseline a failing
	// one is read against (welcome.vue logs every failed `markWelcomed` attempt).
	await setup.info().attach('browser-console.txt', {
		body: consoleLines.join('\n') || '(no console output)',
		contentType: 'text/plain',
	});
	await setup.info().attach('network.txt', {
		body: networkLines.join('\n') || '(no requests)',
		contentType: 'text/plain',
	});
});

/**
 * Bootstrap the instance and sign in, once, for every other spec.
 *
 * This used to register through `/auth/register`, which cannot work: that page
 * only renders a form behind an `?redirect=/invite/accept…` invite link, and the
 * backend refuses any signup once an account exists
 * (convex/auth/registrationGate.ts). A fresh instance is bootstrapped the way
 * `owlat bootstrap-org` does it — `POST /seed/admin`, which writes through the
 * raw adapter and so is the one path the invite gate does not apply to.
 *
 * Nothing secret may reach the report or a local trace: the workflow uploads
 * the report publicly. The seed call, the only one that carries the instance
 * secret, runs outside Playwright; the console and network log are redacted;
 * and the workflow scans the report before uploading it
 * (scan-report-secrets.ts).
 *
 * The workflow wipes the deployment immediately before this runs, so the seed's
 * one-shot rule ("refuses if any user exists") is satisfied.
 */
setup('bootstrap the instance and save auth state', async ({ page }) => {
	// Sign-in, the background first-login check and the welcome stamp are three
	// round trips to a cold hosted deployment on top of the seed; the suite's
	// 45 s default leaves no headroom for that. The stamp's share is its own
	// worst-case recovery time (see timing.ts); a run that commits on the first
	// try uses a second or two of it.
	setup.setTimeout(SETUP_BEFORE_STAMP_MS + WELCOME_STAMP_SETTLE_MS);

	const started = Date.now();
	const stamp = () => `+${((Date.now() - started) / 1000).toFixed(1)}s`;
	const log = (lines: string[], line: string) => {
		lines.push(`${stamp()} ${redactForReport(line, deployments)}`);
	};
	page.on('console', (message) => log(consoleLines, `[${message.type()}] ${message.text()}`));
	page.on('pageerror', (error) => log(consoleLines, `[pageerror] ${error.stack ?? error.message}`));

	const requestLine = (method: string, url: string, outcome: string) =>
		networkLines.push(`${stamp()} ${describeRequest({ method, url, outcome }, deployments)}`);
	page.on('requestfinished', async (request) => {
		if (!LOGGED_RESOURCE_TYPES.has(request.resourceType())) return;
		const response = await request.response().catch(() => null);
		// responseEnd is -1 when the timing is unknown.
		const end = request.timing().responseEnd;
		const took = end >= 0 ? ` ${Math.round(end)} ms` : '';
		requestLine(request.method(), request.url(), `${response?.status() ?? '?'}${took}`);
	});
	page.on('requestfailed', (request) => {
		if (!LOGGED_RESOURCE_TYPES.has(request.resourceType())) return;
		requestLine(request.method(), request.url(), `failed: ${request.failure()?.errorText ?? '?'}`);
	});
	page.on('websocket', (socket) => {
		requestLine('WS', socket.url(), 'open');
		socket.on('socketerror', (error) => requestLine('WS', socket.url(), `error: ${error}`));
		socket.on('close', () => requestLine('WS', socket.url(), 'closed'));
	});

	const owner = testUser();
	const siteUrl = process.env['NUXT_PUBLIC_CONVEX_SITE_URL'];
	const instanceSecret = process.env['CONVEX_TEST_INSTANCE_SECRET'];

	if (!siteUrl || !instanceSecret) {
		throw new Error(
			'NUXT_PUBLIC_CONVEX_SITE_URL and CONVEX_TEST_INSTANCE_SECRET must be set: the suite seeds ' +
				'its own owner through POST /seed/admin (see .github/workflows/e2e.yml).'
		);
	}

	// Not through Playwright's `request` fixture: its requests, headers included,
	// are recorded in any trace. See seedAdmin.ts.
	await seedAdmin({ siteUrl, instanceSecret, owner });

	await page.goto('/auth/login');
	await page.getByLabel('Email').fill(owner.email);
	// Exact: the field's show/hide toggle is labelled "Show password", so a
	// substring match resolves to two elements.
	await page.getByLabel('Password', { exact: true }).fill(owner.password);
	await page.getByRole('button', { name: 'Sign in' }).click();

	// A brand-new owner has never seen the welcome screen, so `first-login.global`
	// sends them there. The check does not block the navigation: /dashboard
	// renders first, and once Convex has authenticated the new session the
	// onboarding query answers and the redirect follows. Wait for that answer
	// rather than guessing with reloads: the page ends up on /welcome (never
	// welcomed) or the guard caches the "welcomed" answer in localStorage.
	await page.waitForURL(/\/(dashboard|welcome)/, { timeout: 30_000 });

	// `.catch`: evaluating mid-navigation throws "execution context destroyed".
	const welcomedCached = () =>
		page
			.evaluate(() => Object.keys(localStorage).some((key) => key.startsWith('owlat:welcomed:')))
			.catch(() => false);
	const onWelcome = () => new URL(page.url()).pathname.startsWith('/welcome');
	await expect
		.poll(async () => onWelcome() || (await welcomedCached()), { timeout: 30_000 })
		.toBe(true);

	if (onWelcome()) {
		await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
		// welcome.vue writes the cache entry only once `markWelcomed` has
		// committed, so after this the server knows the owner has been welcomed
		// and leaving cannot bounce back here. The seeded owner has no mailbox, so
		// the screen shows the "no mailbox yet" surface, which has no exit link of
		// its own: navigate the way a member would, by opening the dashboard.
		//
		// The stamp retries a failure, so wait until it settles: committed (the
		// cache entry) or given up (the page's retry note). Giving up fails here
		// at once, rather than after the timeout, and the attached
		// browser-console.txt has every attempt and its cause.
		const stampOutcome = async () => {
			if (await welcomedCached()) return 'saved';
			const gaveUp = await page
				.getByTestId('welcome-stamp-failed')
				.isVisible()
				.catch(() => false);
			return gaveUp ? 'gave-up' : 'pending';
		};
		await expect.poll(stampOutcome, { timeout: WELCOME_STAMP_SETTLE_MS }).not.toBe('pending');
		expect(
			await stampOutcome(),
			'welcome.vue gave up on markWelcomed; see browser-console.txt in the report'
		).toBe('saved');
		await page.goto('/dashboard');
	}

	await expect(page).toHaveURL(/\/dashboard/);
	// The cache entry goes into the saved storage state, so every later spec gets
	// a deterministic /dashboard without asking the server again.
	expect(await welcomedCached()).toBe(true);

	await page.context().storageState({ path: STORAGE_STATE });
});
