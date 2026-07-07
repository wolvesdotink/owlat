import type { Page, Locator } from '@playwright/test';

export class EmailEditorPage {
	readonly page: Page;
	readonly saveButton: Locator;
	readonly backButton: Locator;

	constructor(page: Page) {
		this.page = page;
		// Save button in EditorHeader: has text "Save" or "Saving..."
		this.saveButton = page.getByRole('button', { name: /save/i });
		// Back button is an ArrowLeft icon button in the header
		this.backButton = page.locator('button:has(svg.lucide-arrow-left)').first();
	}

	/**
	 * Navigate to marketing templates listing, create a new blank template, and end up in the editor.
	 */
	async gotoNewTemplate() {
		await this.page.goto('/dashboard/send/marketing');
		// Wait for page to load
		await this.page.waitForSelector('h1', { timeout: 15_000 });

		// Click "New Marketing Template" button
		await this.page.getByRole('button', { name: /New Marketing Template/i }).click();

		// Template library modal opens - click "Start from Blank" (first preset option)
		const blankPreset = this.page.getByText('Empty Canvas');
		await blankPreset.waitFor({ timeout: 10_000 });
		await blankPreset.click();

		// Now on "Customize Your Template" step - fill in name and submit
		const nameInput = this.page.getByLabel('Template Name');
		await nameInput.waitFor({ timeout: 5_000 });
		await nameInput.fill(`E2E Test Template ${Date.now()}`);

		// Click "Create & Edit"
		await this.page.getByRole('button', { name: /Create & Edit/i }).click();

		// Wait for redirect to editor
		await this.page.waitForURL('**/emails/**/edit', { timeout: 15_000 });
	}

	async waitForEditorReady() {
		// Wait for the loading spinner to disappear
		await this.page
			.locator('text=Loading template')
			.waitFor({ state: 'hidden', timeout: 15_000 })
			.catch(() => {
				// May already be loaded
			});
	}

	async save() {
		await this.saveButton.click();
	}
}
