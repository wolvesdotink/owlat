import { test, expect } from '@playwright/test';
import { LoginPage } from '../page-objects/LoginPage';
import { RegisterPage } from '../page-objects/RegisterPage';
import { testUser } from '../fixtures/test-data';

// Auth tests run without pre-saved auth state
test.use({ storageState: { cookies: [], origins: [] } });

test.describe('Authentication', () => {
	test('register a new user and redirect to dashboard', async ({ page }) => {
		const registerPage = new RegisterPage(page);
		await registerPage.goto();

		const timestamp = Date.now();
		await registerPage.register(
			'New Test User',
			`new-user-${timestamp}@example.com`,
			'SecurePassword123!'
		);

		await page.waitForURL('**/dashboard**', { timeout: 15_000 });
		await expect(page).toHaveURL(/\/dashboard/);
	});

	test('login with valid credentials and redirect to dashboard', async ({ page }) => {
		const loginPage = new LoginPage(page);
		await loginPage.goto();

		// The account auth.setup.ts registered for this run.
		const TEST_USER = testUser();
		await loginPage.login(TEST_USER.email, TEST_USER.password);

		await page.waitForURL('**/dashboard**', { timeout: 15_000 });
		await expect(page).toHaveURL(/\/dashboard/);
	});

	test('login with invalid credentials shows error', async ({ page }) => {
		const loginPage = new LoginPage(page);
		await loginPage.goto();

		await loginPage.login('nonexistent@example.com', 'WrongPassword123');

		await expect(loginPage.errorAlert).toBeVisible({ timeout: 10_000 });
	});

	test('empty login form shows validation errors', async ({ page }) => {
		const loginPage = new LoginPage(page);
		await loginPage.goto();

		await loginPage.submitButton.click();

		await expect(page.getByText('Email is required')).toBeVisible({ timeout: 5_000 });
		await expect(page.getByText('Password is required')).toBeVisible();
	});

	test('protected route redirects to login', async ({ page }) => {
		await page.goto('/dashboard');

		await page.waitForURL('**/auth/login**', { timeout: 10_000 });
		await expect(page).toHaveURL(/\/auth\/login/);
	});

	test('logout redirects to login', async ({ page }) => {
		const loginPage = new LoginPage(page);
		await loginPage.goto();

		const TEST_USER = testUser();
		await loginPage.login(TEST_USER.email, TEST_USER.password);
		await page.waitForURL('**/dashboard**', { timeout: 15_000 });

		// The sidebar's user menu is a button named after the signed-in user.
		await page.getByRole('button', { name: TEST_USER.name }).click();
		await page.getByRole('button', { name: 'Sign out' }).click();

		await page.waitForURL('**/auth/login**', { timeout: 10_000 });
		await expect(page).toHaveURL(/\/auth\/login/);
	});
});
