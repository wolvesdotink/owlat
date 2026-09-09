import type { Page, Locator } from '@playwright/test';
import { BasePage } from './BasePage';

export class RegisterPage extends BasePage {
	readonly nameInput: Locator;
	readonly emailInput: Locator;
	readonly passwordInput: Locator;
	readonly submitButton: Locator;
	readonly errorAlert: Locator;

	constructor(page: Page) {
		super(page);
		this.nameInput = page.getByLabel('Name');
		this.emailInput = page.getByLabel('Email');
		this.passwordInput = page.getByLabel('Password');
		this.submitButton = page.getByRole('button', { name: 'Create account' });
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
