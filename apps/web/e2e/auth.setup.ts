import { test as setup, expect } from '@playwright/test';
import { TEST_USER } from './fixtures/test-data';

setup('register and save auth state', async ({ page }) => {
	await page.goto('/auth/register');

	// Wait for Nuxt/Vue hydration so @submit.prevent is wired up
	// Without this, clicking the button triggers a native form POST instead of handleSubmit()
	await page.waitForLoadState('networkidle');

	await page.getByLabel('Name').fill(TEST_USER.name);
	await page.getByLabel('Email').fill(TEST_USER.email);
	await page.getByLabel('Password').fill(TEST_USER.password);

	// Click and wait for the signup API call to complete
	const [signupResponse] = await Promise.all([
		page.waitForResponse(
			(resp) => resp.url().includes('/api/auth/sign-up') && resp.request().method() === 'POST',
			{ timeout: 30_000 },
		),
		page.getByRole('button', { name: 'Create account' }).click(),
	]);

	// Fail fast with a clear message if signup API returned an error
	if (!signupResponse.ok()) {
		const body = await signupResponse.text().catch(() => '(no body)');
		throw new Error(
			`Signup API returned ${signupResponse.status()}: ${body}. ` +
				'Check that CONVEX_TEST_URL/CONVEX_TEST_SITE_URL secrets are configured and the Convex test instance is running.',
		);
	}

	// Check that no error message appeared on the registration page
	const errorBanner = page.locator('[class*="bg-error"]');
	if (await errorBanner.isVisible({ timeout: 2_000 }).catch(() => false)) {
		const errorText = await errorBanner.textContent();
		throw new Error(`Registration failed with error on page: ${errorText}`);
	}

	// Wait for redirect to dashboard after registration + auto-org creation
	await page.waitForURL('**/dashboard**', { timeout: 30_000 });

	await page.context().storageState({ path: '.auth/user.json' });
});
