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
	await page.getByLabel('Password').fill(owner.password);
	await page.getByRole('button', { name: 'Sign in' }).click();

	// A brand-new owner has never seen the welcome screen, so `first-login.global`
	// routes them there — but only when its Convex query wins the race against JWT
	// setup, which makes a bare wait for /dashboard flaky. Accept either, and when
	// we do land on /welcome let it stamp `welcomedAt` (it fires markWelcomed on
	// mount) so every later spec gets a deterministic /dashboard.
	await page.waitForURL(/\/(dashboard|welcome)/, { timeout: 30_000 });

	if (new URL(page.url()).pathname.startsWith('/welcome')) {
		await expect(page.getByRole('heading').first()).toBeVisible({ timeout: 15_000 });
		await page.goto('/dashboard');
	}

	await expect(page).toHaveURL(/\/dashboard/, { timeout: 30_000 });

	await page.context().storageState({ path: STORAGE_STATE });
});
