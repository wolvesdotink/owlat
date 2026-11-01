import type { Page, Locator } from '@playwright/test';
import { expect } from '@playwright/test';
import { BasePage } from './BasePage';

/**
 * The email template editor, opened on a DRAFT template.
 *
 * A draft saves itself: the header shows its save state ("Saved", "Saving…",
 * "Saved · now") where a published template has a Save button. Nothing here
 * clicks Save, so a test cannot pass by finding a button the draft does not
 * have.
 */
export class EmailEditorPage extends BasePage {
	/** The draft's save-state region: the state, then the age of the last save. */
	readonly saveStatus: Locator;
	/** Just the state ("Saved", "Saving…"), the live region inside it. */
	readonly saveState: Locator;
	/**
	 * The name field on the canvas. The header carries a second textbox with the
	 * same label, so this is scoped to the canvas's subject fields.
	 */
	readonly nameField: Locator;

	constructor(page: Page) {
		super(page);
		this.saveStatus = page.getByTestId('draft-save-status');
		this.saveState = this.saveStatus.getByRole('status');
		this.nameField = page
			.getByTestId('subject-fields')
			.getByRole('textbox', { name: 'Template name', exact: true });
	}

	/**
	 * Navigate to marketing templates listing, create a new blank template, and
	 * end up in the editor. Returns the name the template was created with.
	 */
	async gotoNewTemplate(): Promise<string> {
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
		const name = `E2E Test Template ${Date.now()}`;
		const nameInput = this.page.getByLabel('Template Name');
		await nameInput.waitFor({ timeout: 5_000 });
		await nameInput.fill(name);

		// Click "Create & Edit"
		await this.page.getByRole('button', { name: /Create & Edit/i }).click();

		// Wait for redirect to editor
		await this.page.waitForURL('**/emails/**/edit', { timeout: 15_000 });
		return name;
	}

	/**
	 * The draft named `name` is on the canvas and its autosave runs. The editor
	 * mounts only once the template row is in and live co-editing finished
	 * connecting, so an edit made after this is an edit to the loaded draft.
	 */
	async waitForDraftReady(name: string) {
		await expect(this.saveState).toBeVisible({ timeout: 15_000 });
		await expect(this.nameField).toHaveValue(name);
	}

	/**
	 * Wait until a save made on this page landed. Only a save that landed puts
	 * its age beside the state ("Saved · now"); a draft that was merely loaded
	 * reads a bare "Saved", so this cannot pass before an edit was written.
	 *
	 * A RegExp is matched against the raw textContent, where the template
	 * whitespace between the state and the age survives as two spaces
	 * ("Saved  · now") that the browser collapses on screen. Match any run of
	 * whitespace there, as a string expectation would after normalizing.
	 */
	async waitForAutosaveAcknowledged() {
		await expect(this.saveStatus).toHaveText(/^Saved\s+·\s/);
	}
}
