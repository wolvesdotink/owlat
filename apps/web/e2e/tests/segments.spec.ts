import { test, expect } from '@playwright/test';
import { SegmentsPage } from '../page-objects/SegmentsPage';

test.describe('Segments', () => {
	let segmentsPage: SegmentsPage;
	const testSegmentName = `E2E Segment ${Date.now()}`;

	test.beforeEach(async ({ page }) => {
		segmentsPage = new SegmentsPage(page);
		await segmentsPage.goto();
	});

	test('create a segment with name and condition', async ({ page }) => {
		await segmentsPage.createSegment({
			name: testSegmentName,
			description: 'Created by E2E tests',
		});

		// Verify segment appears in the list
		const segmentRow = segmentsPage.getSegmentRow(testSegmentName);
		await expect(segmentRow).toBeVisible({ timeout: 10_000 });
	});

	test('edit segment name', async ({ page }) => {
		// Create a segment to edit
		const originalName = `Edit Test ${Date.now()}`;
		await segmentsPage.createSegment({ name: originalName });

		// Wait for it to appear
		await expect(segmentsPage.getSegmentRow(originalName)).toBeVisible({
			timeout: 10_000,
		});

		// Edit the segment
		const modal = await segmentsPage.editSegment(originalName);
		const nameInput = modal.locator('#segment-name');
		await nameInput.clear();

		const updatedName = `${originalName} Updated`;
		await nameInput.fill(updatedName);

		// Click "Save Changes" button
		await modal.getByRole('button', { name: /Save Changes/i }).click();
		await modal.waitFor({ state: 'hidden', timeout: 10_000 });

		// Verify updated name appears
		await expect(segmentsPage.getSegmentRow(updatedName)).toBeVisible({
			timeout: 10_000,
		});
	});

	test('delete segment with confirmation', async ({ page }) => {
		// Create a segment to delete
		const nameToDelete = `Delete Test ${Date.now()}`;
		await segmentsPage.createSegment({ name: nameToDelete });

		// Wait for it to appear
		await expect(segmentsPage.getSegmentRow(nameToDelete)).toBeVisible({
			timeout: 10_000,
		});

		// Delete it
		await segmentsPage.deleteSegment(nameToDelete);

		// Verify it's gone
		await expect(segmentsPage.getSegmentRow(nameToDelete)).not.toBeVisible({
			timeout: 10_000,
		});
	});
});
