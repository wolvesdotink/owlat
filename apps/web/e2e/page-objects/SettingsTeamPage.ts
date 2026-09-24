import type { Page, Locator } from '@playwright/test';
import { BasePage } from './BasePage';

export class SettingsTeamPage extends BasePage {
	readonly inviteButton: Locator;

	constructor(page: Page) {
		super(page);
		// Exact: the empty roster's "Invite a teammate" and the pending
		// invites' "Copy invite link" contain the same word.
		this.inviteButton = page.getByRole('button', { name: 'Invite', exact: true });
	}

	async goto() {
		await this.page.goto('/dashboard/admin/team');
		await this.expectOnPage(/^Team$/);
	}
}
