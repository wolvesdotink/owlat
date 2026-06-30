import type { Page, Locator } from '@playwright/test';

export class RegisterPage {
	readonly page: Page;
	readonly nameInput: Locator;
	readonly emailInput: Locator;
	readonly passwordInput: Locator;
	readonly submitButton: Locator;
	readonly loginLink: Locator;
	readonly errorAlert: Locator;

	constructor(page: Page) {
		this.page = page;
		this.nameInput = page.getByLabel('Name');
		this.emailInput = page.getByLabel('Email');
		this.passwordInput = page.getByLabel('Password');
		this.submitButton = page.getByRole('button', { name: 'Create account' });
		this.loginLink = page.getByRole('link', { name: 'Sign in' });
		this.errorAlert = page.locator('.bg-error-subtle');
	}

	async goto() {
		await this.page.goto('/auth/register');
	}

	async register(name: string, email: string, password: string) {
		await this.nameInput.fill(name);
		await this.emailInput.fill(email);
		await this.passwordInput.fill(password);
		await this.submitButton.click();
	}
}
