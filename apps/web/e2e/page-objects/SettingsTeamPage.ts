import type { Page, Locator } from '@playwright/test';
import { BasePage } from './BasePage';

export class SettingsTeamPage extends BasePage {
	readonly inviteButton: Locator;

	constructor(page: Page) {
		super(page);
		this.inviteButton = page.getByRole('button', { name: 'Invite Member' });
	}

	async goto() {
		await this.page.goto('/dashboard/settings/team');
		await this.waitForHeading();
	}

	async inviteMember(email: string, role: 'admin' | 'editor' = 'editor') {
		await this.inviteButton.click();
		await this.waitForModal();

		// Fill email using the Input component (label "Email Address")
		await this.modal.getByLabel(/Email Address/i).fill(email);

		// Select role via toggle buttons (not a <select>)
		if (role === 'admin') {
			await this.modal.getByRole('button', { name: /Admin/ }).click();
		}
		// Editor is the default selection, no click needed

		// Submit - button says "Send Invitation"
		await this.clickModalButton(/Send Invitation/);
		await this.waitForModalClose();
	}

	/** Get a member row from the members list by matching text */
	getMemberRow(text: string): Locator {
		return this.page.locator('.divide-y > div').filter({ hasText: text });
	}

	async removeMember(memberName: string) {
		const memberRow = this.getMemberRow(memberName);
		// Click the more actions dropdown or the remove button
		await memberRow.locator('button[title="Remove member"]').click();
		// Confirmation modal opens (UiModal)
		await this.waitForModal();
		await this.clickModalButton(/Remove Member/);
		await this.waitForModalClose();
	}
}
