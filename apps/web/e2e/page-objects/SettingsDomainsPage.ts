import type { Page, Locator } from '@playwright/test';
import { BasePage } from './BasePage';

export class SettingsDomainsPage extends BasePage {
	readonly addDomainButton: Locator;

	constructor(page: Page) {
		super(page);
		this.addDomainButton = page.getByRole('button', { name: 'Add Domain' });
	}

	async goto() {
		await this.page.goto('/dashboard/delivery/domains');
		await this.waitForHeading();
	}

	async addDomain(domain: string) {
		await this.addDomainButton.click();
		await this.waitForModal();
		await this.modal.locator('#domain-name').fill(domain);
		await this.clickModalButton(/Add Domain/);
		await this.waitForModalClose();
	}

	async deleteDomain(domain: string) {
		// Each domain is a card row; find the one containing the domain text
		const domainCard = this.page.locator('.card').filter({ hasText: domain });
		// The remove button has title="Remove domain"
		await domainCard.locator('button[title="Remove domain"]').click();
		// UiConfirmationDialog opens via UiModal (role="dialog")
		await this.waitForModal();
		// Confirm button text is "Remove Domain"
		await this.clickModalButton(/Remove Domain/);
		await this.waitForModalClose();
	}

	getDomainCard(domain: string): Locator {
		return this.page.locator('.card').filter({ hasText: domain });
	}

	async verifyDomain(domain: string) {
		const domainCard = this.getDomainCard(domain);
		await domainCard.getByRole('button', { name: /Verify/ }).click();
	}

	async expandDomain(domain: string) {
		const domainCard = this.getDomainCard(domain);
		// Click the domain header row to toggle expansion
		await domainCard.locator('.cursor-pointer').click();
	}
}
