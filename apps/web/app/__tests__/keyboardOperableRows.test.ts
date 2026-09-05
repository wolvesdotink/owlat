/**
 * Accessibility contract for the interactive rows that used to be mouse-only
 * <div @click> / <tr @click> elements on the delivery (domains, webhooks) and
 * send (marketing, transactional) pages. They are exposed to assistive tech
 * and the keyboard as real buttons: focusable (tabindex="0"), announced
 * (role="button"), operable with Enter and Space, and — for the expandable
 * delivery rows — reflecting open/closed state via aria-expanded.
 *
 * The two extracted rows are MOUNTED and driven with real keyboard events,
 * including the contract that activating a nested action control never fires
 * the row's own action. The marketing/transactional rows are inline in their
 * Convex-backed pages, so their opening tags are read from the source.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { capitalize } from 'vue';
import { mount } from '@vue/test-utils';
import RecordRow from '~/components/domains/RecordRow.vue';
import WebhookRow from '~/components/webhooks/WebhookRow.vue';
import { createTestI18n, i18nStubs } from '~/__tests__/i18n';
import { formatDate } from '~/utils/formatters';

Object.assign(globalThis, { useI18n: i18nStubs.useI18n });

const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');

const marketing = read('../pages/dashboard/send/marketing/index.vue');
const transactional = read('../pages/dashboard/send/transactional/index.vue');

const rowStubs = {
	Icon: { template: '<i />' },
	UiIconBox: { template: '<i />' },
	UiBadge: { template: '<span><slot /></span>' },
	DomainsDNSRecordPanel: true,
	DomainsReceivingDnsSection: true,
	DomainsReturnPathEditor: true,
	DomainsStreamSubdomainPlanPanel: true,
	DomainsYahooCflPanel: true,
	DomainsDnsPropagationNote: true,
};

function mountDomainRow() {
	return mount(RecordRow, {
		props: {
			domain: {
				_id: 'domain_1',
				domain: 'mail.example.com',
				status: 'pending',
				createdAt: 0,
				verifiedAt: null,
				lastVerifiedAt: null,
				lastRegistrationError: null,
				dmarcPolicy: 'none',
				dnsRecords: { spf: { type: 'TXT', host: '@', value: 'v=spf1 ~all' }, dkim: [] },
				verificationResults: undefined,
			},
			isExpanded: false,
			canForceVerify: false,
			canManageDomains: true,
			isForcing: false,
			isVerifying: false,
			isUpdatingDmarc: false,
			autoRecheckActive: false,
			spfCoexistence: null,
			dmarcPolicyOptions: [{ value: 'none', label: 'None', hint: '' }],
			showReceivingDns: false,
			inboundMailHost: null,
			inboundPort: 25,
			inboundEnabled: false,
		} as never,
		global: { plugins: [createTestI18n()], stubs: rowStubs, mocks: { capitalize } },
	});
}

function mountWebhookRow() {
	return mount(WebhookRow, {
		props: {
			webhook: {
				_id: 'webhook_1',
				name: 'Order events',
				url: 'https://hooks.example.com/orders',
				events: [],
				isActive: true,
				createdAt: 0,
				updatedAt: 0,
			},
			expanded: true,
			toggling: false,
			sendingTest: false,
		} as never,
		global: { plugins: [createTestI18n()], stubs: rowStubs, mocks: { formatDate } },
	});
}

describe.each([
	['domains', mountDomainRow, 'toggle', 'domain-records-domain_1'],
	['webhooks', mountWebhookRow, 'toggleExpanded', 'webhook-details-webhook_1'],
] as const)('%s row header', (_name, mountRow, event, panelId) => {
	it('is a focusable button that names its state and its panel', () => {
		const header = mountRow().get('[role="button"]');
		expect(header.attributes('tabindex')).toBe('0');
		expect(header.attributes('aria-expanded')).toBeDefined();
		expect(header.attributes('aria-controls')).toBe(panelId);
		expect(header.attributes('aria-label')).toBeTruthy();
	});

	it('toggles on Enter and on Space, and Space does not scroll the page', async () => {
		const wrapper = mountRow();
		const header = wrapper.get('[role="button"]');
		await header.trigger('keydown', { key: 'Enter' });
		expect(wrapper.emitted(event)).toHaveLength(1);
		const space = new KeyboardEvent('keydown', { key: ' ', bubbles: true, cancelable: true });
		header.element.dispatchEvent(space);
		await wrapper.vm.$nextTick();
		expect(wrapper.emitted(event)).toHaveLength(2);
		expect(space.defaultPrevented).toBe(true);
	});

	it('does not toggle when a nested control is activated with the keyboard', async () => {
		const wrapper = mountRow();
		// The domain row nests Verify/Remove inside the header (hence `.self` on
		// its keydown handlers); the webhook row keeps its actions in the panel.
		const nested = wrapper.findAll('button')[0];
		expect(nested).toBeDefined();
		await nested!.trigger('keydown', { key: 'Enter' });
		await nested!.trigger('keydown', { key: ' ' });
		expect(wrapper.emitted(event)).toBeUndefined();
	});
});

/** Every opening tag in `src` whose attribute list contains `marker`. */
function tagsWith(src: string, marker: string): string[] {
	const tags: string[] = [];
	let idx = src.indexOf(marker);
	while (idx !== -1) {
		const start = src.lastIndexOf('<', idx);
		const end = src.indexOf('>', idx);
		if (start === -1 || end === -1) break;
		tags.push(src.slice(start, end + 1));
		idx = src.indexOf(marker, end);
	}
	return tags;
}

/** The single `<tagName …>` opening tag that carries `marker`. */
function pick(src: string, marker: string, tagName: string): string {
	const matches = tagsWith(src, marker).filter((t) => t.startsWith(`<${tagName}`));
	expect(
		matches.length,
		`expected exactly one <${tagName}> carrying \`${marker}\`, found ${matches.length}`
	).toBe(1);
	return matches[0]!;
}

/** Assert a container tag is a keyboard-operable, non-bubbling activation surface. */
function expectActivationContainer(tag: string) {
	expect(tag).toMatch(/role="button"/);
	expect(tag).toMatch(/tabindex="0"/);
	// Operable by keyboard, mirroring components/campaigns/CommandRow.vue.
	expect(tag).toMatch(/@keydown\.enter\.self=/);
	expect(tag).toMatch(/@keydown\.space\.self\.prevent=/);
	// `.self` is what prevents a nested control's keyboard activation from also
	// firing this handler — a bare @keydown.enter would reintroduce the defect.
	expect(tag).not.toMatch(/@keydown\.enter="/);
	// Enter has no default on these elements, so `.prevent` on it is inert; the
	// reference pattern omits it.
	expect(tag).not.toMatch(/@keydown\.enter\.prevent/);
}

describe('send template cards and rows are keyboard-operable', () => {
	it('marketing: both the grid card and the list row activate without bubbling', () => {
		expectActivationContainer(pick(marketing, '@click="handleEdit(template._id)"', 'UiCard'));
		expectActivationContainer(pick(marketing, '@click="handleEdit(template._id)"', 'tr'));
		// Nested action controls exist (overlay + row buttons) with @click.stop —
		// `.self` on the containers keeps their keyboard activation isolated.
		expect(marketing).toMatch(/@click\.stop=/);
	});

	it('transactional: both the grid card and the list row activate without bubbling', () => {
		expectActivationContainer(pick(transactional, '@click="handleEdit(email._id)"', 'UiCard'));
		expectActivationContainer(pick(transactional, '@click="handleEdit(email._id)"', 'tr'));
		expect(transactional).toMatch(/@click\.stop=/);
		// Icon-only controls that relied on `title` alone are now labelled — the
		// accessible names come from the message catalog, so pin the bindings.
		expect(transactional).toMatch(
			/:aria-label="t\('dashboard\.send\.transactional\.index\.viewApiCode'\)"/
		);
		expect(transactional).toMatch(/:aria-label="t\('common\.edit'\)"/);
	});
});

describe('custom sort dropdowns expose listbox semantics linked to their trigger', () => {
	const cases = [
		{ name: 'marketing', src: marketing, id: 'marketing-sort-listbox' },
		{ name: 'transactional', src: transactional, id: 'transactional-sort-listbox' },
	];

	for (const { name, src, id } of cases) {
		it(`${name}: trigger and listbox are aria-linked with per-option state`, () => {
			// UiButton renders a native <button> and forwards aria-* via $attrs,
			// so the design-system trigger satisfies the same contract.
			const trigger = pick(src, 'aria-haspopup="listbox"', 'UiButton');
			expect(trigger).toMatch(/:aria-expanded=/);
			expect(trigger).toContain(`aria-controls="${id}"`);

			const listbox = pick(src, 'role="listbox"', 'div');
			expect(listbox).toContain(`id="${id}"`);

			// Options announce their selected state.
			const option = pick(src, 'role="option"', 'button');
			expect(option).toMatch(/:aria-selected=/);
		});
	}
});
