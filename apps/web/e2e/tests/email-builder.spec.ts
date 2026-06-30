import { test, expect } from '@playwright/test';
import { EmailEditorPage } from '../page-objects/EmailEditorPage';

test.describe('Email Builder', () => {
	let editor: EmailEditorPage;

	test.beforeEach(async ({ page }) => {
		editor = new EmailEditorPage(page);
	});

	test('navigate to marketing templates listing', async ({ page }) => {
		await page.goto('/dashboard/mail/marketing');

		// Verify page loaded with correct heading
		await expect(page.getByText('Marketing Templates')).toBeVisible({ timeout: 15_000 });

		// Verify "New Marketing Template" button is visible
		await expect(
			page.getByRole('button', { name: /New Marketing Template/i })
		).toBeVisible();
	});

	test('create new template from blank and open editor', async ({ page }) => {
		await editor.gotoNewTemplate();
		await editor.waitForEditorReady();

		// Verify we're in the editor - should see Save button
		await expect(editor.saveButton).toBeVisible({ timeout: 10_000 });
	});

	test('editor shows text input area for new content', async ({ page }) => {
		await editor.gotoNewTemplate();
		await editor.waitForEditorReady();

		// The editor should have a content-editable area (TipTap / ProseMirror)
		const editorContent = page.locator('.ProseMirror, [contenteditable="true"]');
		await expect(editorContent.first()).toBeVisible({ timeout: 10_000 });
	});

	test('save template updates save button state', async ({ page }) => {
		await editor.gotoNewTemplate();
		await editor.waitForEditorReady();

		// Save the template
		await editor.save();

		// Verify save completed (button should be enabled again)
		await expect(editor.saveButton).toBeEnabled({ timeout: 10_000 });
	});
});
