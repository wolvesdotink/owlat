import type { Page, Locator } from '@playwright/test';
import { BasePage } from './BasePage';

export class SettingsApiKeysPage extends BasePage {
	readonly createKeyButton: Locator;

	constructor(page: Page) {
		super(page);
		// Scoped to the header: this page renders the SAME label in its empty
		// state too, so unscoped it is ambiguous the moment the list query
		// resolves. It passed serially only because the assertion polled before
		// the list loaded — one button in the DOM, instant pass — and failed under
		// two workers. Green while the page was still loading is not green.
		this.createKeyButton = this.headerAction('Create API Key');
	}

	async goto() {
		await this.page.goto('/dashboard/admin/team/api');
		await this.expectOnPage(/^API$/);
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
		await this.clickModalButton(/Create key/i);
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
