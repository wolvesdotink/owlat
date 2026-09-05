import { test, expect } from '@playwright/test';
import { SettingsDomainsPage } from '../page-objects/SettingsDomainsPage';

test.describe('Settings — Tracking Domains', () => {
	let trackingPage: SettingsDomainsPage;

	test.beforeEach(async ({ page }) => {
		trackingPage = new SettingsDomainsPage(page, 'tracking');
		await trackingPage.goto();
	});

	test('tracking domains section is present on the domains page', async ({ page }) => {
		await expect(page.getByRole('heading', { name: 'Tracking Domains' })).toBeVisible({
			timeout: 15_000,
		});
		await expect(trackingPage.addButton).toBeVisible();
	});

	test('add a tracking domain', async ({ page }) => {
		const domain = `track-${Date.now()}.example.com`;
		await trackingPage.addDomain(domain);

		await expect(page.getByText(domain)).toBeVisible({ timeout: 10_000 });
	});

	test('empty domain shows validation error', async () => {
		await trackingPage.addButton.click();
		await trackingPage.waitForModal();

		await trackingPage.clickModalButton(/Add Tracking Domain/);

		await expect(trackingPage.modal.getByTestId('domain-error')).toHaveText('Enter your domain', {
			timeout: 10_000,
		});
	});

	test('expanding a tracking domain reveals its CNAME record', async ({ page }) => {
		const domain = `track-cname-${Date.now()}.example.com`;
		await trackingPage.addDomain(domain);
		await expect(page.getByText(domain)).toBeVisible({ timeout: 10_000 });

		await trackingPage.expandDomain(domain);

		// The CNAME target is derived from THIS deployment's own tracking host
		// (CONVEX_SITE_URL), not a hardcoded SaaS host — so assert the CNAME record
		// is shown rather than a literal host value the deployment env decides.
		const card = trackingPage.getDomainCard(domain);
		await expect(card.getByText('CNAME')).toBeVisible({ timeout: 10_000 });
	});

	test('verify gives feedback: row auto-expands to reveal the CNAME and a toast fires', async ({
		page,
	}) => {
		// Regression: verifyTrackingDomain returns void on the backend, so the
		// Operation module's run() resolved to `undefined` on success too. The FE
		// `if (result === undefined) return` then bailed before expanding the row
		// and toasting — making Verify a no-feedback stub. Backend now returns
		// `{ success: true }`, so the success UX must be reachable.
		const domain = `track-verify-${Date.now()}.example.com`;
		await trackingPage.addDomain(domain);
		await expect(page.getByText(domain)).toBeVisible({ timeout: 10_000 });

		await trackingPage.verifyDomain(domain);

		await trackingPage.expectToast(/Checking DNS/, 10_000);

		// The row auto-expands so the CNAME to set is in view while DNS propagates.
		const card = trackingPage.getDomainCard(domain);
		await expect(card.getByText('CNAME')).toBeVisible({ timeout: 10_000 });
	});

	test('remove a tracking domain with confirmation', async ({ page }) => {
		const domain = `track-delete-${Date.now()}.example.com`;
		await trackingPage.addDomain(domain);
		await expect(page.getByText(domain)).toBeVisible({ timeout: 10_000 });

		// deleteDomain() awaits waitForModalClose(), so this implicitly
		// asserts the confirm dialog closes on a successful remove (the backend now
		// returns `{ success: true }`, making deleteModal.close() reachable).
		await trackingPage.deleteDomain(domain);

		await expect(page.getByText(domain)).not.toBeVisible({ timeout: 10_000 });
		await trackingPage.expectToast(/Tracking domain removed/, 10_000);
	});
});
