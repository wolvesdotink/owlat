import { test, expect } from '@playwright/test';
import { SettingsTeamPage } from '../page-objects/SettingsTeamPage';
import { testUser } from '../fixtures/test-data';

test.describe('Settings — Team Members', () => {
	let teamPage: SettingsTeamPage;

	test.beforeEach(async ({ page }) => {
		teamPage = new SettingsTeamPage(page);
		await teamPage.goto();
	});

	test('navigate to team settings', async ({ page }) => {
		// The Settings split (#788, #800) renamed the page to "Team"; its roster
		// is the "Members" section.
		await expect(page.getByRole('heading', { level: 1, name: 'Team', exact: true })).toBeVisible({
			timeout: 15_000,
		});
		await expect(
			page.getByRole('heading', { level: 2, name: 'Members', exact: true })
		).toBeVisible();
	});

	test('current user appears in members list', async ({ page }) => {
		// The E2E test user's name should be visible in the member list
		// Scoped to the members table. Unscoped, this also matched the sidebar's
		// user-menu button — so it passed on ANY page the sidebar renders,
		// including the dashboard the admin guard used to bounce us to. It was
		// green while testing nothing.
		await expect(page.locator('tbody tr').filter({ hasText: testUser().name }).first()).toBeVisible(
			{ timeout: 10_000 }
		);
	});

	test('invite modal shows validation for empty email', async () => {
		await teamPage.inviteButton.click();
		await teamPage.waitForModal();

		// Try to submit without entering an email
		await teamPage.clickModalButton(/Send invitation/i);

		// Validation error should appear
		await expect(teamPage.modal.getByText('Email is required')).toBeVisible({
			timeout: 10_000,
		});
	});

	test('invite modal shows validation for invalid email', async () => {
		await teamPage.inviteButton.click();
		await teamPage.waitForModal();

		// Enter an invalid email
		await teamPage.modal.getByLabel(/Email Address/i).fill('not-an-email');

		// Submit
		await teamPage.clickModalButton(/Send invitation/i);

		// Validation error for invalid email format
		await expect(teamPage.modal.getByText('Please enter a valid email address')).toBeVisible({
			timeout: 10_000,
		});
	});
});
