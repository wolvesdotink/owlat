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
		await this.expectOnPage('API Keys');
	}

	async createApiKey(name: string) {
		await this.createKeyButton.click();
		await this.waitForModal();
		await this.modal.locator('#key-name').fill(name);
		// A key now needs at least one scope ("keys are scoped to least
		// privilege") — filling only the name leaves the form invalid and the
		// modal simply never advances, which is what this spec used to sit and
		// time out on.
		await this.modal.getByRole('checkbox').first().check();
		await this.clickModalButton(/Create Key/);
		// The create modal gives way to the one-time "API Key Created" display.
		// By heading, inside the dialog: the same words also appear in the success
		// toast, so a bare getByText matches two nodes.
		await this.modal.getByRole('heading', { name: 'API Key Created' }).waitFor({ timeout: 10_000 });
	}

	/** Close the "API Key Created" display modal by clicking Done */
	async closeCreatedKeyModal() {
		await this.clickModalButton('Done');
		await this.waitForModalClose();
	}
}
