import { test, expect } from '@playwright/test';
import { EmailEditorPage } from '../page-objects/EmailEditorPage';

test.describe('Email Builder', () => {
	let editor: EmailEditorPage;

	test.beforeEach(async ({ page }) => {
		editor = new EmailEditorPage(page);
	});

	test('navigate to marketing templates listing', async ({ page }) => {
		await page.goto('/dashboard/send/marketing');

		// Verify page loaded with correct heading
		// By role: the string also appears in the breadcrumb, so getByText matched
		// two nodes.
		await expect(page.getByRole('heading', { level: 1, name: 'Marketing Templates' })).toBeVisible({
			timeout: 15_000,
		});

		// Verify "New Marketing Template" button is visible
		await expect(page.getByRole('button', { name: /New Marketing Template/i })).toBeVisible();
	});

	test('create new template from blank and open editor', async ({ page }) => {
		const name = await editor.gotoNewTemplate();
		await editor.waitForDraftReady(name);

		// A new template is a draft, and a draft saves itself: the header shows
		// its save state where a published template has a Save button.
		await expect(editor.saveState).toHaveText('Saved');
		await expect(page.getByRole('button', { name: 'Save', exact: true })).toHaveCount(0);
	});

	test('adding a text block gives an editable area', async ({ page }) => {
		const name = await editor.gotoNewTemplate();
		await editor.waitForDraftReady(name);

		// A blank template starts with an EMPTY document, so there is nothing
		// contenteditable on screen yet — the old version of this test asserted
		// one existed and simply waited out its timeout. The canvas offers to add
		// the first block; take it, and then the editable area is the thing worth
		// asserting.
		await page.getByRole('button', { name: /add a text block/i }).click();

		await expect(page.locator('[contenteditable="true"]').first()).toBeVisible({
			timeout: 10_000,
		});
	});

	test('an edit to a draft is saved without a Save button', async ({ page }) => {
		const name = await editor.gotoNewTemplate();
		await editor.waitForDraftReady(name);
		// Nothing has been saved on this page yet: no age beside the state.
		await expect(editor.saveStatus).toHaveText('Saved');

		const renamed = `${name} renamed`;
		await editor.nameField.fill(renamed);
		await editor.waitForAutosaveAcknowledged();

		// The acknowledgement is the server's: a fresh load shows the edit.
		await page.reload();
		await editor.waitForDraftReady(renamed);
	});
});
