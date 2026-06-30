import type { Page, Locator } from '@playwright/test';

export class CampaignWizardPage {
	readonly page: Page;

	// Basics step
	readonly campaignNameInput: Locator;
	readonly fromNameInput: Locator;
	readonly fromEmailInput: Locator;
	readonly replyToInput: Locator;

	// Navigation
	readonly nextButton: Locator;
	readonly backButton: Locator;
	readonly cancelButton: Locator;

	constructor(page: Page) {
		this.page = page;

		// Basics step fields (using id selectors from BasicsStep.vue)
		this.campaignNameInput = page.locator('#campaignName');
		this.fromNameInput = page.locator('#fromName');
		this.fromEmailInput = page.locator('#fromEmail');
		this.replyToInput = page.locator('#replyTo');

		// Navigation buttons
		this.nextButton = page.getByRole('button', { name: 'Next' });
		this.backButton = page.getByRole('button', { name: /back/i });
		this.cancelButton = page.getByRole('button', { name: 'Cancel' });
	}

	async goto() {
		await this.page.goto('/dashboard/campaigns/new');
		// Wait for the form to be ready
		await this.campaignNameInput.waitFor({ timeout: 15_000 });
	}

	async fillBasics(data: {
		campaignName: string;
		fromName: string;
		fromEmail: string;
		replyTo?: string;
	}) {
		await this.campaignNameInput.fill(data.campaignName);
		await this.fromNameInput.fill(data.fromName);
		await this.fromEmailInput.fill(data.fromEmail);
		if (data.replyTo) {
			await this.replyToInput.fill(data.replyTo);
		}
	}

	async submitBasicsStep() {
		await this.nextButton.click();
	}

	async getValidationErrors() {
		// Error messages are <p> tags with text-error class (not the <span> asterisks)
		return this.page.locator('p.text-error').allTextContents();
	}
}
