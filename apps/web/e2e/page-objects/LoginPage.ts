import type { Page, Locator } from '@playwright/test';

export class LoginPage {
	readonly page: Page;
	readonly emailInput: Locator;
	readonly passwordInput: Locator;
	readonly submitButton: Locator;
	readonly registerLink: Locator;
	readonly errorAlert: Locator;

	constructor(page: Page) {
		this.page = page;
		this.emailInput = page.getByLabel('Email');
		this.passwordInput = page.getByLabel('Password');
		this.submitButton = page.getByRole('button', { name: 'Sign in' });
		this.registerLink = page.getByRole('link', { name: 'Create one' });
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
