import { test, expect } from '@playwright/test';
import { SettingsDomainsPage } from '../page-objects/SettingsDomainsPage';

test.describe('Settings — Sending Domains', () => {
	let domainsPage: SettingsDomainsPage;

	test.beforeEach(async ({ page }) => {
		domainsPage = new SettingsDomainsPage(page);
		await domainsPage.goto();
	});

	test('navigate to domains settings page', async ({ page }) => {
		await expect(page.getByRole('heading', { name: 'Sending Domains' })).toBeVisible({
			timeout: 15_000,
		});

		// The "Add Domain" button should be present
		await expect(domainsPage.addDomainButton).toBeVisible();
	});

	test('add a new domain', async ({ page }) => {
		const domain = `e2e-${Date.now()}.example.com`;
		await domainsPage.addDomain(domain);

		// Verify the domain appears on the page
		await expect(page.getByText(domain)).toBeVisible({ timeout: 10_000 });
	});

	test('empty domain shows validation error', async ({ page }) => {
		await domainsPage.addDomainButton.click();
		await domainsPage.waitForModal();

		// Try to submit without entering a domain
		await domainsPage.clickModalButton(/Add Domain/);

		// Validation error should appear inside the modal
		await expect(domainsPage.modal.getByText('Domain is required')).toBeVisible({
			timeout: 10_000,
		});
	});

	test('delete domain with confirmation', async ({ page }) => {
		// First add a domain to delete
		const domain = `e2e-delete-${Date.now()}.example.com`;
		await domainsPage.addDomain(domain);

		// Verify it appeared
		await expect(page.getByText(domain)).toBeVisible({ timeout: 10_000 });

		// Delete the domain
		await domainsPage.deleteDomain(domain);

		// Verify it's gone
		await expect(page.getByText(domain)).not.toBeVisible({ timeout: 10_000 });
	});
});
