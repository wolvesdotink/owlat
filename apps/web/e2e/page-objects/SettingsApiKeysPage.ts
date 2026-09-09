import type { Page, Locator } from '@playwright/test';
import { BasePage } from './BasePage';

export class SettingsApiKeysPage extends BasePage {
	readonly createKeyButton: Locator;

	constructor(page: Page) {
		super(page);
		this.createKeyButton = page.getByRole('button', { name: 'Create API Key' });
	}

	async goto() {
		await this.page.goto('/dashboard/admin/team/api');
		await this.waitForHeading();
	}

	async createApiKey(name: string) {
		await this.createKeyButton.click();
		await this.waitForModal();
		await this.modal.locator('#key-name').fill(name);
		await this.clickModalButton(/Create Key/);
		// The create modal gives way to the one-time "API Key Created" display.
		await this.page.getByText('API Key Created').waitFor({ timeout: 10_000 });
	}

	/** Close the "API Key Created" display modal by clicking Done */
	async closeCreatedKeyModal() {
		await this.clickModalButton('Done');
		await this.waitForModalClose();
	}
}
