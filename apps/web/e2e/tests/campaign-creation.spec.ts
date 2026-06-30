import { test, expect } from '@playwright/test';
import { CampaignWizardPage } from '../page-objects/CampaignWizardPage';

test.describe('Campaign Creation Wizard', () => {
	let wizard: CampaignWizardPage;

	test.beforeEach(async ({ page }) => {
		wizard = new CampaignWizardPage(page);
		await wizard.goto();
	});

	test('complete basics step and advance to audience', async ({ page }) => {
		// Step 1: Basics
		await expect(page.getByText('Campaign Details')).toBeVisible();
		await wizard.fillBasics({
			campaignName: 'E2E Test Campaign',
			fromName: 'Test Sender',
			fromEmail: 'test@example.com',
		});
		await wizard.submitBasicsStep();

		// Step 2: Audience - wait for step to load
		await expect(page.getByText(/audience|subscribers|recipients/i)).toBeVisible({
			timeout: 10_000,
		});
	});

	test('submitting empty basics step shows validation errors', async ({ page }) => {
		// Try to submit without filling anything
		await wizard.submitBasicsStep();

		// Should show validation error messages (as <p> tags with text-error class)
		const errors = page.locator('p.text-error');
		await expect(errors.first()).toBeVisible({ timeout: 5_000 });

		// Verify specific error messages
		await expect(page.getByText('Campaign name is required')).toBeVisible();
		await expect(page.getByText('From name is required')).toBeVisible();
		await expect(page.getByText('From email is required')).toBeVisible();
	});

	test('step navigation allows going back and forward', async ({ page }) => {
		// Fill basics and proceed
		await wizard.fillBasics({
			campaignName: 'Navigation Test',
			fromName: 'Test Sender',
			fromEmail: 'test@example.com',
		});
		await wizard.submitBasicsStep();

		// Wait for audience step
		await expect(page.getByText(/audience|subscribers|recipients/i)).toBeVisible({
			timeout: 10_000,
		});

		// Go back
		await page.getByRole('button', { name: /back/i }).click();

		// Should be back on basics step with form data preserved
		await expect(page.getByText('Campaign Details')).toBeVisible({ timeout: 5_000 });
		await expect(wizard.campaignNameInput).toHaveValue('Navigation Test');
	});
});
