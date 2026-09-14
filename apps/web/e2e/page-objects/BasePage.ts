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

	/**
	 * The modal the user is looking at.
	 *
	 * Scoped to VISIBLE dialogs: a page can have more than one mounted at once
	 * (a create form whose success state opens a second one), and a bare
	 * `[role="dialog"]` then resolves to two elements and fails Playwright's
	 * strict mode — reported as "strict mode violation", which says nothing about
	 * the flow under test.
	 */
	get modal(): Locator {
		// `.last()`, not `.first()`: Teleport appends each dialog to the end of
		// <body>, so when one modal hands over to another the OLDEST is first —
		// and during the leave transition that is the one on its way out.
		return this.page.locator('[role="dialog"]:visible').last();
	}

	/** Wait for a modal to open */
	async waitForModal(timeout = 10_000) {
		await this.modal.waitFor({ timeout });
		return this.modal;
	}

	/** Wait until no modal is on screen. */
	async waitForModalClose(timeout = 10_000) {
		await expect(this.page.locator('[role="dialog"]:visible')).toHaveCount(0, { timeout });
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
		// Wait for EITHER outcome first. Asserting the URL up front passes
		// instantly — an SPA redirect lands after the middleware runs — so the
		// message below could never actually fire, and the H1 timeout carried the
		// failure while saying nothing about the redirect.
		const ownHeading = this.page.getByRole('heading', { level: 1, name: heading });
		await expect(
			ownHeading.or(this.page.getByRole('heading', { name: /sign in|welcome back/i })).first()
		).toBeVisible({ timeout });

		await expect(
			this.page,
			`expected ${String(heading)}, but the app redirected to sign-in`
		).not.toHaveURL(/\/auth\/login/);
		await expect(ownHeading).toBeVisible({ timeout });
	}
}
