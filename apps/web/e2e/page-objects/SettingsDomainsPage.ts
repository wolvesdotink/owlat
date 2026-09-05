import type { Page, Locator } from '@playwright/test';
import { BasePage } from './BasePage';

export type DomainKind = 'sending' | 'tracking';

/**
 * The two domain lists on the Sending Domains settings page. Both are card
 * rows fed by the same DomainsAddDomainForm modal; only the button labels and
 * the accessible names of the row actions differ, so the kind is a parameter.
 */
const LABELS: Record<DomainKind, { add: string; remove: string; removeConfirm: RegExp }> = {
	sending: { add: 'Add Domain', remove: 'Remove domain', removeConfirm: /Remove Domain/ },
	tracking: {
		add: 'Add Tracking Domain',
		remove: 'Remove tracking domain',
		removeConfirm: /Remove Tracking Domain/,
	},
};

export class SettingsDomainsPage extends BasePage {
	readonly kind: DomainKind;
	/** The header button; the empty-state CTA shares its label, hence `.first()`. */
	readonly addButton: Locator;

	constructor(page: Page, kind: DomainKind = 'sending') {
		super(page);
		this.kind = kind;
		this.addButton = page.getByRole('button', { name: LABELS[kind].add }).first();
	}

	async goto() {
		await this.page.goto('/dashboard/admin/delivery/domains');
		await this.waitForHeading();
	}

	async addDomain(domain: string) {
		await this.addButton.click();
		await this.waitForModal();
		await this.modal.getByTestId('domain-input').fill(domain);
		await this.clickModalButton(LABELS[this.kind].add);
		await this.waitForModalClose();
	}

	getDomainCard(domain: string): Locator {
		return this.page.locator('.card').filter({ hasText: domain });
	}

	async deleteDomain(domain: string) {
		await this.getDomainCard(domain)
			.getByRole('button', { name: LABELS[this.kind].remove })
			.click();
		await this.waitForModal();
		await this.clickModalButton(LABELS[this.kind].removeConfirm);
		await this.waitForModalClose();
	}

	async verifyDomain(domain: string) {
		await this.getDomainCard(domain)
			.getByRole('button', { name: /Verify|Check DNS/ })
			.click();
	}

	/** Toggle the row's disclosure by its header. */
	async expandDomain(domain: string) {
		await this.getDomainCard(domain).locator('.cursor-pointer').first().click();
	}
}
