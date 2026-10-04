import { test as setup, expect } from '@playwright/test';
import { testUser } from './fixtures/test-data';
import { seedAdmin } from './seedAdmin';
import { SETUP_BEFORE_STAMP_MS, WELCOME_STAMP_SETTLE_MS } from './timing';
import { STORAGE_STATE } from './storage-state';

/** The browser console of the setup run, attached to the report afterwards. */
const consoleLines: string[] = [];

setup.afterEach(async () => {
	// Attached on success too: a passing run's console is the baseline a failing
	// one is read against (welcome.vue logs every failed `markWelcomed` attempt).
	await setup.info().attach('browser-console.txt', {
		body: consoleLines.join('\n') || '(no console output)',
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
 * Nothing secret may reach the trace or the attachments: a failed setup keeps
 * its trace, and the workflow uploads both with the report. The seed call, the
 * only one that carries the instance secret, runs outside Playwright, and the
 * workflow scans the report before uploading it (scan-report-secrets.ts).
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
	page.on('console', (message) => {
		consoleLines.push(`${stamp()} [${message.type()}] ${message.text()}`);
	});
	page.on('pageerror', (error) => {
		consoleLines.push(`${stamp()} [pageerror] ${error.stack ?? error.message}`);
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
	// are recorded in the trace, and a failed setup's trace is published with the
	// report. See seedAdmin.ts.
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
