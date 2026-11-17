import type { Page, Locator } from '@playwright/test';
import { BasePage } from './BasePage';

export type DomainKind = 'sending' | 'tracking';

/**
 * The two domain lists on the Sending Domains settings page. Both are card
 * rows fed by the same DomainsAddDomainForm modal; only the button labels and
 * the accessible names of the row actions differ, so the kind is a parameter.
 */
const LABELS: Record<DomainKind, { add: string; remove: string; removeConfirm: RegExp }> = {
	sending: { add: 'Add Domain', remove: 'Remove domain', removeConfirm: /Remove domain/i },
	tracking: {
		add: 'Add Tracking Domain',
		remove: 'Remove tracking domain',
		removeConfirm: /Remove tracking domain/i,
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
		await this.expectOnPage('Sending Domains');
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

	/** The row's disclosure button, which reports whether its DNS record is shown. */
	getDomainDisclosure(domain: string): Locator {
		return this.getDomainCard(domain).getByRole('button', { name: `CNAME record for ${domain}` });
	}

	/**
	 * Toggle the row by clicking its domain name, as a mouse does. Only the
	 * tracking list calls this. The disclosure button spans the whole row and
	 * lies under the name and the status badge, so its own centre may be
	 * covered, depending on how wide the name renders.
	 */
	async expandDomain(domain: string) {
		await this.getDomainCard(domain).getByRole('heading', { name: domain, exact: true }).click();
	}
}
