import type { Page, Locator } from '@playwright/test';
import { BasePage } from './BasePage';

export class EmailEditorPage extends BasePage {
	readonly saveButton: Locator;
	readonly backButton: Locator;

	constructor(page: Page) {
		super(page);
		// Save button in EditorHeader: has text "Save" or "Saving..."
		this.saveButton = page.getByRole('button', { name: /save/i });
		// EditorHeader names its icon-only back control for assistive tech.
		// "Back to Emails" in the editor; a bare 'Back' matched nothing.
		this.backButton = page.getByRole('button', { name: /Back to Emails/i });
	}

	/**
	 * Navigate to marketing templates listing, create a new blank template, and end up in the editor.
	 */
	async gotoNewTemplate() {
		await this.page.goto('/dashboard/send/marketing');
		await this.expectOnPage('Marketing Templates');

		// Click "New Marketing Template" button
		await this.page.getByRole('button', { name: /New Marketing Template/i }).click();

		// Pick the blank preset by its NAME, inside the modal.
		// `getByText('Empty Canvas')` matched two nodes — the preset's description
		// ("Empty Canvas") and the copy around it — so it was a strict-mode
		// violation; the preset itself is "Start from Blank"
		// (shared.data.marketingTemplatePresets.blank.name).
		const blankPreset = this.modal.getByRole('button', { name: /Start from Blank/i });
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
		// `hidden` also resolves when the loading state never rendered.
		await this.page.getByText('Loading template').waitFor({ state: 'hidden', timeout: 15_000 });
	}

	async save() {
		await this.saveButton.click();
	}
}
