import type { Page, Locator } from '@playwright/test';
import { BasePage } from './BasePage';

/**
 * Page object for the API Keys settings page.
 *
 * Note: The API Keys page uses custom Teleport modals instead of UiModal,
 * so they do NOT have role="dialog". We use a custom overlay locator
 * for these modals.
 */
export class SettingsApiKeysPage extends BasePage {
	readonly createKeyButton: Locator;

	constructor(page: Page) {
		super(page);
		this.createKeyButton = page.getByRole('button', { name: 'Create API Key' });
	}

	async goto() {
		await this.page.goto('/dashboard/settings/api');
		await this.waitForHeading();
	}

	/**
	 * Get the currently visible overlay modal (Teleport-based, no role="dialog").
	 * These modals render as fixed overlays in the body.
	 */
	private get overlayModal(): Locator {
		return this.page.locator('.fixed.inset-0.z-50');
	}

	/** Wait for a Teleport overlay modal to appear */
	private async waitForOverlayModal(timeout = 10_000) {
		await this.overlayModal.waitFor({ timeout });
		return this.overlayModal;
	}

	/** Wait for a Teleport overlay modal to close */
	private async waitForOverlayModalClose(timeout = 10_000) {
		await this.overlayModal.waitFor({ state: 'hidden', timeout });
	}

	async createApiKey(name: string) {
		await this.createKeyButton.click();
		const modal = await this.waitForOverlayModal();

		// Fill the name input
		await modal.locator('#key-name').fill(name);

		// Submit the form - button says "Create Key"
		await modal.getByRole('button', { name: /Create Key/ }).click();

		// The create modal closes and the "created key" modal opens
		// Wait for the key display modal with the API key
		await this.page.getByText('API Key Created').waitFor({ timeout: 10_000 });
	}

	/** Get the displayed API key text after creation */
	async getCreatedKeyText(): Promise<string> {
		const modal = this.overlayModal;
		const keyCode = modal.locator('code').last();
		return (await keyCode.textContent()) ?? '';
	}

	/** Close the "API Key Created" display modal by clicking Done */
	async closeCreatedKeyModal() {
		const modal = this.overlayModal;
		await modal.getByRole('button', { name: 'Done' }).click();
		await this.waitForOverlayModalClose();
	}

	async revokeApiKey(keyName: string) {
		const row = this.getTableRow(keyName);
		await row.locator('button[title="Revoke Key"]').click();
		const modal = await this.waitForOverlayModal();
		await modal.getByRole('button', { name: /Revoke Key/ }).click();
		await this.waitForOverlayModalClose();
	}

	async deleteApiKey(keyName: string) {
		const row = this.getTableRow(keyName);
		await row.locator('button[title="Delete Key"]').click();
		const modal = await this.waitForOverlayModal();
		await modal.getByRole('button', { name: /Delete Key/ }).click();
		await this.waitForOverlayModalClose();
	}
}
