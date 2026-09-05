import type { Page, Locator } from '@playwright/test';
import { BasePage } from './BasePage';

export class SettingsTeamPage extends BasePage {
	readonly inviteButton: Locator;

	constructor(page: Page) {
		super(page);
		this.inviteButton = page.getByRole('button', { name: 'Invite Member' });
	}

	async goto() {
		await this.page.goto('/dashboard/admin/team');
		await this.waitForHeading();
	}
}
