import type { Page, Locator } from '@playwright/test';
import { BasePage } from './BasePage';

/**
 * Page object for the Tracking Domains section on the Sending Domains settings
 * page. Mirrors {@link SettingsDomainsPage} but targets the tracking-domains
 * controls (separate "Add Tracking Domain" / "Remove tracking domain" labels).
 */
export class SettingsTrackingDomainsPage extends BasePage {
	readonly addButton: Locator;

	constructor(page: Page) {
		super(page);
		this.addButton = page.getByRole('button', { name: 'Add Tracking Domain' });
	}

	async goto() {
		await this.page.goto('/dashboard/settings/domains');
		await this.waitForHeading();
	}

	async addTrackingDomain(domain: string) {
		// The header "Add Tracking Domain" button (the empty-state CTA shares the
		// same label, so .first() keeps this robust whether or not rows exist).
		await this.addButton.first().click();
		await this.waitForModal();
		await this.modal.locator('#tracking-domain-name').fill(domain);
		await this.clickModalButton(/Add Tracking Domain/);
		await this.waitForModalClose();
	}

	getTrackingDomainCard(domain: string): Locator {
		return this.page.locator('.card').filter({ hasText: domain });
	}

	async removeTrackingDomain(domain: string) {
		const card = this.getTrackingDomainCard(domain);
		await card.locator('button[title="Remove tracking domain"]').click();
		await this.waitForModal();
		await this.clickModalButton(/Remove Tracking Domain/);
		await this.waitForModalClose();
	}

	async verifyTrackingDomain(domain: string) {
		const card = this.getTrackingDomainCard(domain);
		await card.getByRole('button', { name: /Verify/ }).click();
	}

	async expandTrackingDomain(domain: string) {
		const card = this.getTrackingDomainCard(domain);
		await card.locator('.cursor-pointer').first().click();
	}
}
