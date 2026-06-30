import { test, expect } from '@playwright/test';
import { TopicsPage } from '../page-objects/TopicsPage';

test.describe('Topics', () => {
	let topicsPage: TopicsPage;

	test.beforeEach(async ({ page }) => {
		topicsPage = new TopicsPage(page);
		await topicsPage.goto();
	});

	test('create a topic and see it in the table', async ({ page }) => {
		const topicName = `Newsletter ${Date.now()}`;
		await topicsPage.createTopic({
			name: topicName,
			description: 'Created by E2E tests',
		});

		// Verify topic appears in the table
		await topicsPage.expectRowVisible(topicName);
	});

	test('create topic with double opt-in enabled', async ({ page }) => {
		const topicName = `DOI Topic ${Date.now()}`;
		await topicsPage.createTopic({
			name: topicName,
			description: 'Double opt-in topic',
			requireDoubleOptIn: true,
		});

		// Verify topic appears in the table
		await topicsPage.expectRowVisible(topicName);
	});

	test('edit topic name', async ({ page }) => {
		// Create a topic to edit
		const originalName = `Edit Test ${Date.now()}`;
		await topicsPage.createTopic({ name: originalName });

		// Wait for it to appear
		await topicsPage.expectRowVisible(originalName);

		// Edit the topic
		const modal = await topicsPage.editTopic(originalName);
		const nameInput = modal.getByLabel('Name');
		await nameInput.clear();

		const updatedName = `${originalName} Updated`;
		await nameInput.fill(updatedName);

		await modal.getByRole('button', { name: 'Save Changes' }).click();
		await topicsPage.waitForModalClose();

		// Verify updated name appears
		await topicsPage.expectRowVisible(updatedName);
	});

	test('delete topic with confirmation', async ({ page }) => {
		// Create a topic to delete
		const nameToDelete = `Delete Test ${Date.now()}`;
		await topicsPage.createTopic({ name: nameToDelete });

		// Wait for it to appear
		await topicsPage.expectRowVisible(nameToDelete);

		// Delete it
		await topicsPage.deleteTopic(nameToDelete);

		// Verify it's gone
		await topicsPage.expectRowNotVisible(nameToDelete);
	});

	test('empty form shows validation error', async ({ page }) => {
		await topicsPage.newTopicButton.click();
		await topicsPage.waitForModal();

		// Try to submit without filling in the name
		await topicsPage.clickModalButton('Create Topic');

		// Expect validation error text inside the modal
		await expect(topicsPage.modal.getByText('Topic name is required')).toBeVisible({
			timeout: 10_000,
		});
	});

	test('search filters topics', async ({ page }) => {
		// Create a topic with a unique name
		const topicName = `Searchable ${Date.now()}`;
		await topicsPage.createTopic({ name: topicName });

		// Wait for it to appear
		await topicsPage.expectRowVisible(topicName);

		// Search for the topic
		await topicsPage.searchTopics(topicName);

		// Verify the row is still visible after filtering
		await topicsPage.expectRowVisible(topicName);

		// Search for something that won't match
		await topicsPage.searchTopics('xyznonexistent999');

		// Verify the topic is no longer visible
		await topicsPage.expectRowNotVisible(topicName);
	});
});
