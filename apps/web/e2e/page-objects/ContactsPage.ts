import type { Page, Locator } from '@playwright/test';

export class ContactsPage {
	readonly page: Page;
	readonly searchInput: Locator;
	readonly addContactButton: Locator;
	readonly importButton: Locator;
	readonly tableRows: Locator;
	readonly selectAllCheckbox: Locator;
	readonly selectedCountText: Locator;

	constructor(page: Page) {
		this.page = page;
		this.searchInput = page.getByPlaceholder('Search by email or name...');
		this.addContactButton = page.getByRole('button', { name: 'Add Contact' });
		this.importButton = page.getByRole('button', { name: 'Import' });
		this.tableRows = page.locator('tbody tr');
		this.selectAllCheckbox = page.locator('thead button').first();
		this.selectedCountText = page.locator('text=/\\d+ selected/');
	}

	async goto() {
		await this.page.goto('/dashboard/audience/contacts');
		// Wait for Convex data to load
		await this.page.waitForSelector('table, [class*="empty"]', { timeout: 15_000 });
	}

	async addContact(data: { email: string; firstName?: string; lastName?: string }) {
		await this.addContactButton.click();

		// Wait for modal to open (UiModal with role="dialog")
		const modal = this.page.locator('[role="dialog"]');
		await modal.waitFor();

		await modal.getByLabel('Email').fill(data.email);
		if (data.firstName) {
			await modal.getByLabel('First Name').fill(data.firstName);
		}
		if (data.lastName) {
			await modal.getByLabel('Last Name').fill(data.lastName);
		}

		// The button says "Create Contact"
		await modal.getByRole('button', { name: 'Create Contact' }).click();

		// Wait for modal to close
		await modal.waitFor({ state: 'hidden', timeout: 10_000 });
	}

	async searchContacts(query: string) {
		await this.searchInput.fill(query);
		// Wait for the network request triggered by debounced search to settle
		await this.page.waitForLoadState('networkidle');
	}

	async importCSV(filePath: string) {
		// Click the Import dropdown trigger
		await this.importButton.click();

		// Select "CSV File" from dropdown menu
		await this.page.getByText('CSV File').click();

		// Wait for import modal to open
		const modal = this.page.locator('[role="dialog"]');
		await modal.waitFor();

		// Upload file via hidden input
		const fileInput = modal.locator('input[type="file"]');
		await fileInput.setInputFiles(filePath);

		return modal;
	}
}
