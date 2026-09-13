import type { Page, Locator } from '@playwright/test';
import { expect } from '@playwright/test';

/**
 * Base page object with shared patterns for modals, toasts, tables and navigation.
 * Every page object extends this.
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

	// ============================================
	// Toast Helpers
	// ============================================

	/**
	 * Assert a toast with matching text is visible.
	 *
	 * By ROLE, not class: `packages/ui/components/ui/Toast.vue` renders its two
	 * stacks as role="alert" / role="status", and never had a class containing
	 * "toast" — the old `[class*="toast"]` matched only the TransitionGroup's
	 * enter/leave classes, and then only for the few frames they exist.
	 */
	async expectToast(text: string | RegExp, timeout = 5_000) {
		const toast = this.page
			.getByRole('alert')
			.or(this.page.getByRole('status'))
			.filter({ hasText: text });
		await expect(toast.first()).toBeVisible({ timeout });
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
	// Region Helpers
	// ============================================

	/**
	 * A page's primary call to action, scoped to the page header.
	 *
	 * A list page renders the SAME label twice while it is empty — once in the
	 * header, once in the empty state — so an unscoped
	 * `getByRole('button', { name: 'New Topic' })` is a strict-mode violation
	 * whenever the list happens to be empty, and passes when it happens not to
	 * be. Both regions carry a data-testid in `packages/ui` for this.
	 */
	headerAction(name: string | RegExp): Locator {
		return this.page.getByTestId('page-header-actions').getByRole('button', { name });
	}

	/** The same call to action as offered by an empty list. */
	emptyStateAction(name: string | RegExp): Locator {
		return this.page.getByTestId('empty-state-action').getByRole('button', { name });
	}

	// ============================================
	// Navigation Helpers
	// ============================================

	/**
	 * Assert we are actually ON this page.
	 *
	 * This used to be `waitForSelector('h1')`, which is true of the login page, of
	 * a dashboard the router bounced us to, and of every error shell — so when a
	 * guard redirected, the spec sailed past `goto()` and failed 15 seconds later
	 * on an unrelated-looking selector. Twenty-six failures presented that way,
	 * and two app bugs hid behind them.
	 *
	 * Naming the redirect is the whole point: assert the page's own H1, and fail
	 * loudly if we landed on the sign-in page instead.
	 */
	async expectOnPage(heading: string | RegExp, timeout = 15_000) {
		await expect(
			this.page,
			`expected ${String(heading)}, but the app redirected to sign-in`
		).not.toHaveURL(/\/auth\/login/);
		await expect(this.page.getByRole('heading', { level: 1, name: heading })).toBeVisible({
			timeout,
		});
	}
}
