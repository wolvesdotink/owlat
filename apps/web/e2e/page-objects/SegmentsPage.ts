import type { Page, Locator } from '@playwright/test';

export class SegmentsPage {
	readonly page: Page;
	readonly newSegmentButton: Locator;
	readonly searchInput: Locator;
	readonly tableRows: Locator;

	constructor(page: Page) {
		this.page = page;
		this.newSegmentButton = page.getByRole('button', { name: 'New Segment' });
		this.searchInput = page.getByPlaceholder('Search segments...');
		this.tableRows = page.locator('tbody tr');
	}

	async goto() {
		await this.page.goto('/dashboard/audience/segments');
		// Wait for page to load
		await this.page.waitForSelector('h1', { timeout: 15_000 });
	}

	async createSegment(data: { name: string; description?: string }) {
		await this.newSegmentButton.click();

		// The segment modal is a custom Teleport modal with role="dialog"
		const modal = this.page.locator('[role="dialog"]');
		await modal.waitFor();

		await modal.locator('#segment-name').fill(data.name);
		if (data.description) {
			await modal.locator('#segment-description').fill(data.description);
		}

		// Add a condition (defaults to "List Membership" type)
		await modal.getByRole('button', { name: /Add Condition/i }).click();

		// Change condition type to "Contact Property" via the select dropdown
		const conditionTypeSelect = modal.locator('select.input').first();
		await conditionTypeSelect.selectOption('contact_property');

		// Click "Create Segment"
		await modal.getByRole('button', { name: /Create Segment/i }).click();

		// Wait for modal to close
		await modal.waitFor({ state: 'hidden', timeout: 10_000 });
	}

	async editSegment(segmentName: string) {
		const row = this.tableRows.filter({ hasText: segmentName });
		// Edit button has title="Edit segment"
		await row.locator('button[title="Edit segment"]').click();

		const modal = this.page.locator('[role="dialog"]');
		await modal.waitFor();
		return modal;
	}

	async deleteSegment(segmentName: string) {
		const row = this.tableRows.filter({ hasText: segmentName });
		// Delete button has title="Delete segment"
		await row.locator('button[title="Delete segment"]').click();

		// Confirm deletion in the UiModal confirmation dialog
		const confirmModal = this.page.locator('[role="dialog"]');
		await confirmModal.waitFor();
		await confirmModal.getByRole('button', { name: /Delete Segment/i }).click();

		// Wait for modal to close
		await confirmModal.waitFor({ state: 'hidden', timeout: 10_000 });
	}

	async getSegmentRow(segmentName: string) {
		return this.tableRows.filter({ hasText: segmentName });
	}
}
