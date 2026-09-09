import type { Page, Locator } from '@playwright/test';
import { BasePage } from './BasePage';

export class SegmentsPage extends BasePage {
	readonly newSegmentButton: Locator;
	readonly searchInput: Locator;

	constructor(page: Page) {
		super(page);
		this.newSegmentButton = page.getByRole('button', { name: 'New Segment' });
		this.searchInput = page.getByPlaceholder('Search segments...');
	}

	async goto() {
		await this.page.goto('/dashboard/audience/segments');
		await this.waitForHeading();
	}

	async createSegment(data: { name: string; description?: string }) {
		await this.newSegmentButton.click();

		const modal = await this.waitForModal();

		await modal.locator('#segment-name').fill(data.name);
		if (data.description) {
			await modal.locator('#segment-description').fill(data.description);
		}

		// Add a condition (defaults to "List Membership" type)
		await modal.getByRole('button', { name: /Add Condition/i }).click();

		// Change condition type to "Contact Property" via the select dropdown
		const conditionTypeSelect = modal.locator('select.input').first();
		await conditionTypeSelect.selectOption('contact_property');

		await modal.getByRole('button', { name: /Create Segment/i }).click();
		await this.waitForModalClose();
	}

	async editSegment(segmentName: string) {
		await this.getTableRow(segmentName).getByRole('button', { name: 'Edit segment' }).click();
		return this.waitForModal();
	}

	async deleteSegment(segmentName: string) {
		await this.getTableRow(segmentName).getByRole('button', { name: 'Delete segment' }).click();
		await this.waitForModal();
		await this.clickModalButton(/Delete Segment/i);
		await this.waitForModalClose();
	}

	getSegmentRow(segmentName: string): Locator {
		return this.getTableRow(segmentName);
	}
}
