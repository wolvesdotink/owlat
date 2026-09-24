import type { Page, Locator } from '@playwright/test';
import { BasePage } from './BasePage';

export class LoginPage extends BasePage {
	readonly emailInput: Locator;
	readonly passwordInput: Locator;
	readonly submitButton: Locator;
	readonly errorAlert: Locator;

	constructor(page: Page) {
		super(page);
		this.emailInput = page.getByLabel('Email');
		// Exact: the field's show/hide toggle is labelled "Show password", so a
		// substring match resolves to two elements.
		this.passwordInput = page.getByLabel('Password', { exact: true });
		this.submitButton = page.getByRole('button', { name: 'Sign in' });
		this.errorAlert = page.locator('.bg-error-subtle');
	}

	async goto() {
		await this.page.goto('/auth/login');
	}

	async login(email: string, password: string) {
		await this.emailInput.fill(email);
		await this.passwordInput.fill(password);
		await this.submitButton.click();
	}
}
