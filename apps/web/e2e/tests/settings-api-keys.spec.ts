import { test, expect } from '@playwright/test';
import { SettingsApiKeysPage } from '../page-objects/SettingsApiKeysPage';

test.describe('Settings — API Keys', () => {
	let apiKeysPage: SettingsApiKeysPage;

	test.beforeEach(async ({ page }) => {
		apiKeysPage = new SettingsApiKeysPage(page);
		await apiKeysPage.goto();
	});

	test('navigate to API keys settings', async ({ page }) => {
		await expect(page.getByRole('heading', { name: 'API Keys' })).toBeVisible({
			timeout: 15_000,
		});

		// The "Create API Key" button should be present
		await expect(apiKeysPage.createKeyButton).toBeVisible();
	});

	test('create a new API key', async ({ page }) => {
		const keyName = `E2E Key ${Date.now()}`;
		await apiKeysPage.createApiKey(keyName);

		// The "API Key Created" modal should be visible with the key
		await expect(page.getByText('API Key Created')).toBeVisible({ timeout: 10_000 });

		// Close the created key modal
		await apiKeysPage.closeCreatedKeyModal();

		// Verify the key name appears in the table
		await apiKeysPage.expectRowVisible(keyName);
	});

	test('empty name shows validation error', async ({ page }) => {
		await apiKeysPage.createKeyButton.click();

		// Wait for the overlay modal to appear
		await page.locator('.fixed.inset-0.z-50').waitFor({ timeout: 10_000 });
		const modal = page.locator('.fixed.inset-0.z-50');

		// Try to submit without filling in a name
		await modal.getByRole('button', { name: /Create Key/ }).click();

		// Validation error should appear
		await expect(modal.getByText('Name is required')).toBeVisible({ timeout: 10_000 });
	});

	test('created key shows key prefix in table', async ({ page }) => {
		const keyName = `E2E Prefix ${Date.now()}`;
		await apiKeysPage.createApiKey(keyName);

		// Close the created key modal
		await apiKeysPage.closeCreatedKeyModal();

		// The key row should show a prefix with "..." suffix
		const row = apiKeysPage.getTableRow(keyName);
		await expect(row).toBeVisible({ timeout: 10_000 });
		await expect(row.locator('code')).toContainText('...', { timeout: 10_000 });
	});
});
