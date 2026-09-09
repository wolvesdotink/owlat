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
		this.passwordInput = page.getByLabel('Password');
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
