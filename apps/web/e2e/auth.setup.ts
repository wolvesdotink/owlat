import { test as setup, expect } from '@playwright/test';
import { hashPassword } from '@owlat/shared/passwordHash';
import { testUser } from './fixtures/test-data';
import { STORAGE_STATE } from './storage-state';

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
 * The workflow wipes the deployment immediately before this runs, so the seed's
 * one-shot rule ("refuses if any user exists") is satisfied.
 */
setup('bootstrap the instance and save auth state', async ({ page, request }) => {
	// Sign-in, the background first-login check and the welcome stamp are three
	// round trips to a cold hosted deployment on top of the seed; the suite's
	// 45 s default leaves no headroom for that.
	setup.setTimeout(90_000);

	const owner = testUser();
	const siteUrl = process.env['NUXT_PUBLIC_CONVEX_SITE_URL'];
	const instanceSecret = process.env['CONVEX_TEST_INSTANCE_SECRET'];

	if (!siteUrl || !instanceSecret) {
		throw new Error(
			'NUXT_PUBLIC_CONVEX_SITE_URL and CONVEX_TEST_INSTANCE_SECRET must be set: the suite seeds ' +
				'its own owner through POST /seed/admin (see .github/workflows/e2e.yml).'
		);
	}

	const seeded = await request.post(`${siteUrl}/seed/admin`, {
		headers: { 'X-Instance-Secret': instanceSecret, 'Content-Type': 'application/json' },
		data: {
			email: owner.email,
			name: owner.name,
			// Same scrypt parameters the setup CLI uses; the endpoint stores the
			// hash verbatim, so anything else is unreadable to BetterAuth.
			passwordHash: await hashPassword(owner.password),
		},
	});

	// 409 = already bootstrapped. Signing in still proves the account works, and
	// failing here would turn "the reset did not run" into a confusing seed error
	// instead of the login error that names it.
	if (!seeded.ok() && seeded.status() !== 409) {
		throw new Error(
			`POST /seed/admin returned ${seeded.status()}: ${await seeded.text()}. The deployment must ` +
				'be reset (POST /dev/reset) before the suite runs.'
		);
	}

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
		await expect.poll(welcomedCached, { timeout: 20_000 }).toBe(true);
		await page.goto('/dashboard');
	}

	await expect(page).toHaveURL(/\/dashboard/);
	// The cache entry goes into the saved storage state, so every later spec gets
	// a deterministic /dashboard without asking the server again.
	expect(await welcomedCached()).toBe(true);

	await page.context().storageState({ path: STORAGE_STATE });
});
