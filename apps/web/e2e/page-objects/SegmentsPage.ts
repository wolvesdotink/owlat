import type { Page, Locator } from '@playwright/test';
import { BasePage } from './BasePage';

export class SegmentsPage extends BasePage {
	readonly newSegmentButton: Locator;
	readonly searchInput: Locator;

	constructor(page: Page) {
		super(page);
		this.newSegmentButton = this.headerAction('New Segment');
		this.searchInput = page.getByPlaceholder('Search segments...');
	}

	async goto() {
		await this.page.goto('/dashboard/audience/segments');
		await this.expectOnPage('Segments');
	}

	async createSegment(data: { name: string; description?: string }) {
		await this.newSegmentButton.click();

		const modal = await this.waitForModal();

		await modal.locator('#segment-name').fill(data.name);
		if (data.description) {
			await modal.locator('#segment-description').fill(data.description);
		}

		// A segment needs a COMPLETE condition, not just a row. The kind already
		// defaults to "Contact Property"; leaving the property unset leaves the
		// form invalid ("Condition 1: Please select a property") and the modal
		// silently refuses to close — which this spec used to sit and time out on,
		// reported as "the modal never closed".
		await modal.getByRole('button', { name: /Add Condition/i }).click();

		// Drive the kind explicitly. It defaults to "Topic Membership", whose
		// second select lists TOPICS — so which control sits at which index
		// depends on the instance's data. Contact Property needs nothing seeded.
		await modal.getByRole('combobox').first().selectOption({ label: 'Contact Property' });
		await modal.getByRole('combobox').nth(1).selectOption({ label: 'Email' });
		await modal.getByPlaceholder('Enter value...').fill('e2e@example.com');

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
