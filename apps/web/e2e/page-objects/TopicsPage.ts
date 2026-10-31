import type { Page, Locator } from '@playwright/test';
import { BasePage } from './BasePage';

export class TopicsPage extends BasePage {
	readonly newTopicButton: Locator;
	readonly searchInput: Locator;

	constructor(page: Page) {
		super(page);
		this.newTopicButton = this.headerAction('New Topic');
		this.searchInput = page.getByPlaceholder('Search topics...');
	}

	async goto() {
		await this.page.goto('/dashboard/audience/topics');
		await this.expectOnPage('Subscription topics');
	}

	async createTopic(data: { name: string; description?: string; requireDoubleOptIn?: boolean }) {
		await this.newTopicButton.click();
		await this.waitForModal();

		await this.modal.getByLabel('Name').fill(data.name);
		if (data.description) {
			await this.modal.getByLabel('Description').fill(data.description);
		}
		if (data.requireDoubleOptIn) {
			await this.modal.getByText('Require double opt-in').click();
		}

		await this.clickModalButton('Create Topic');
		await this.waitForModalClose();
	}

	async editTopic(topicName: string) {
		await this.rowAction(topicName, 'Edit topic').click();
		await this.waitForModal();
		return this.modal;
	}

	async deleteTopic(topicName: string) {
		await this.rowAction(topicName, 'Delete topic').click();
		await this.waitForModal();
		await this.clickModalButton('Delete Topic');
		await this.waitForModalClose();
	}

	/**
	 * An icon-only row action, by its accessible name: the buttons are named by
	 * `aria-label` and show their label in a UiTooltip, with no `title`.
	 */
	private rowAction(topicName: string, name: 'Edit topic' | 'Delete topic'): Locator {
		return this.getTableRow(topicName).getByRole('button', { name, exact: true });
	}

	async searchTopics(query: string) {
		await this.searchInput.fill(query);
		// Wait for debounced search to settle
		await this.page.waitForLoadState('networkidle');
	}
}
