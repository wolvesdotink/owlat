import { test, expect } from '@playwright/test';
import { SettingsTeamPage } from '../page-objects/SettingsTeamPage';
import { TEST_USER } from '../fixtures/test-data';

test.describe('Settings — Team Members', () => {
	let teamPage: SettingsTeamPage;

	test.beforeEach(async ({ page }) => {
		teamPage = new SettingsTeamPage(page);
		await teamPage.goto();
	});

	test('navigate to team settings', async ({ page }) => {
		await expect(page.getByRole('heading', { name: 'Team Members' })).toBeVisible({
			timeout: 15_000,
		});
	});

	test('current user appears in members list', async ({ page }) => {
		// The E2E test user's name should be visible in the member list
		await expect(page.getByText(TEST_USER.name)).toBeVisible({ timeout: 10_000 });
	});

	test('invite modal shows validation for empty email', async ({ page }) => {
		await teamPage.inviteButton.click();
		await teamPage.waitForModal();

		// Try to submit without entering an email
		await teamPage.clickModalButton(/Send Invitation/);

		// Validation error should appear
		await expect(teamPage.modal.getByText('Email is required')).toBeVisible({
			timeout: 10_000,
		});
	});

	test('invite modal shows validation for invalid email', async ({ page }) => {
		await teamPage.inviteButton.click();
		await teamPage.waitForModal();

		// Enter an invalid email
		await teamPage.modal.getByLabel(/Email Address/i).fill('not-an-email');

		// Submit
		await teamPage.clickModalButton(/Send Invitation/);

		// Validation error for invalid email format
		await expect(teamPage.modal.getByText('Please enter a valid email address')).toBeVisible({
			timeout: 10_000,
		});
	});
});
