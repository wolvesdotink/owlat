import type { Page, Locator } from '@playwright/test';
import { expect } from '@playwright/test';

/**
 * Base page object with shared patterns for modals, toasts, and navigation.
 * All page objects can extend this for common functionality.
 */
export class BasePage {
	readonly page: Page;

	constructor(page: Page) {
		this.page = page;
	}

	// ============================================
	// Modal Helpers
	// ============================================

	/** Get the currently visible modal dialog */
	get modal(): Locator {
		return this.page.locator('[role="dialog"]');
	}

	/** Wait for a modal to open */
	async waitForModal(timeout = 10_000) {
		await this.modal.waitFor({ timeout });
		return this.modal;
	}

	/** Wait for the modal to close */
	async waitForModalClose(timeout = 10_000) {
		await this.modal.waitFor({ state: 'hidden', timeout });
	}

	/** Click a button inside the current modal by name */
	async clickModalButton(name: string | RegExp) {
		await this.modal.getByRole('button', { name }).click();
	}

	/** Fill an input inside the current modal by label */
	async fillModalField(label: string, value: string) {
		await this.modal.getByLabel(label).fill(value);
	}

	// ============================================
	// Toast Helpers
	// ============================================

	/** Assert a toast notification with matching text is visible */
	async expectToast(text: string | RegExp, timeout = 5_000) {
		const toast = this.page.locator('[class*="toast"]').filter({ hasText: text });
		await expect(toast).toBeVisible({ timeout });
	}

	// ============================================
	// Table Helpers
	// ============================================

	/** Get table rows */
	get tableRows(): Locator {
		return this.page.locator('tbody tr');
	}

	/** Get a specific table row by text content */
	getTableRow(text: string): Locator {
		return this.tableRows.filter({ hasText: text });
	}

	/** Assert a row with the given text is visible in the table */
	async expectRowVisible(text: string, timeout = 10_000) {
		await expect(this.getTableRow(text)).toBeVisible({ timeout });
	}

	/** Assert a row with the given text is not visible in the table */
	async expectRowNotVisible(text: string, timeout = 10_000) {
		await expect(this.getTableRow(text)).not.toBeVisible({ timeout });
	}

	// ============================================
	// Navigation Helpers
	// ============================================

	/** Wait for the page content to load (table or empty state) */
	async waitForPageContent(timeout = 15_000) {
		await this.page.waitForSelector('table, [class*="empty"]', { timeout });
	}

	/** Wait for a heading to appear */
	async waitForHeading(timeout = 15_000) {
		await this.page.waitForSelector('h1', { timeout });
	}
}
