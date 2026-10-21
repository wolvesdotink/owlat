/**
 * The domain row's header: one disclosure button beside its operation buttons.
 *
 * The header used to be a `role="button"` div with Force verify, Verify and
 * Remove nested inside it, which axe reports as `nested-interactive` and which
 * relied on `.self` / `.stop` modifiers to keep an action's keypress or click
 * from also folding the row. The header is now plain layout: one native
 * `<button>` carrying `aria-expanded`/`aria-controls` lies over the whole row,
 * and the actions are its siblings, so no event from an action can ever reach
 * the toggle. The identity text sits above that overlay so it stays selectable;
 * a plain click on it still toggles, a click that ends a selection does not.
 * These tests pin that structure, the keyboard and pointer contract on both
 * sides of it, and a clean axe scan of the row. Hit-testing itself (which
 * element a click lands on) needs a layout engine and is checked in a browser.
 */
import { describe, it, expect } from 'vitest';
import { capitalize } from 'vue';
import { mount, type VueWrapper } from '@vue/test-utils';

import RecordRow from '../RecordRow.vue';
import { auditA11y } from '~/__tests__/a11y';
import { createTestI18n, i18nStubs } from '~/__tests__/i18n';

Object.assign(globalThis, { useI18n: i18nStubs.useI18n });

/** The expanded panel's children carry their own suites; the header is what is under test. */
const panelStubs = {
	DomainsDNSRecordPanel: true,
	DomainsReceivingDnsSection: true,
	DomainsExternalReceivingSection: true,
	DomainsReceivingModeSwitch: true,
	DomainsReturnPathEditor: true,
	DomainsStreamSubdomainPlanPanel: true,
	DomainsYahooCflPanel: true,
	DomainsDmarcReportingPanel: true,
	DomainsDnsPropagationNote: true,
};

function rowProps(overrides: Record<string, unknown> = {}) {
	return {
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
		// Every action the header can show: Force verify, Verify and Remove.
		canForceVerify: true,
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
		...overrides,
	};
}

function mountRow(overrides: Record<string, unknown> = {}) {
	return mount(RecordRow, {
		props: rowProps(overrides) as never,
		attachTo: document.body,
		global: {
			plugins: [createTestI18n()],
			stubs: { Icon: { template: '<i />' }, UiIconBox: { template: '<i />' }, ...panelStubs },
			mocks: { capitalize },
		},
	});
}

const INTERACTIVE = 'button, a[href], input, select, textarea, [role="button"], [tabindex]';

const disclosure = (wrapper: VueWrapper) =>
	wrapper.get('[aria-controls="domain-records-domain_1"]');

/** The header's operation buttons, in DOM order: Force verify, Verify, Remove. */
function actions(wrapper: VueWrapper) {
	return wrapper
		.findAll('button')
		.filter((button) => !button.attributes('aria-controls'))
		.slice(0, 3);
}

/** Every keyboard event a browser sends for one Enter or Space press, then the click it synthesises. */
async function press(target: Element, key: 'Enter' | ' ') {
	for (const type of ['keydown', 'keypress', 'keyup'] as const) {
		target.dispatchEvent(new KeyboardEvent(type, { key, bubbles: true, cancelable: true }));
	}
	target.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
	await Promise.resolve();
}

describe('domain row disclosure', () => {
	it('is a native button that names its state and the panel it controls', async () => {
		const wrapper = mountRow();
		const button = disclosure(wrapper);
		expect(button.element.tagName).toBe('BUTTON');
		expect(button.attributes('type')).toBe('button');
		expect(button.attributes('aria-expanded')).toBe('false');
		expect(button.attributes('aria-label')).toBe('DNS records for mail.example.com');
		// No role override: a native button is focusable and is activated by
		// Enter and Space without any key handling of its own.
		expect(button.attributes('role')).toBeUndefined();
		expect(button.attributes('tabindex')).toBeUndefined();

		await wrapper.setProps({ isExpanded: true });
		expect(button.attributes('aria-expanded')).toBe('true');
		expect(wrapper.find('#domain-records-domain_1').exists()).toBe(true);
		wrapper.unmount();
	});

	it('is the only control carrying the disclosure state', () => {
		const wrapper = mountRow();
		expect(wrapper.findAll('[aria-expanded]')).toHaveLength(1);
		expect(wrapper.findAll('[aria-controls]')).toHaveLength(1);
		wrapper.unmount();
	});

	it('toggles when activated', async () => {
		const wrapper = mountRow();
		await press(disclosure(wrapper).element, 'Enter');
		await press(disclosure(wrapper).element, ' ');
		expect(wrapper.emitted('toggle')).toHaveLength(2);
		wrapper.unmount();
	});

	it('nests no interactive element, and no action sits inside an interactive element', () => {
		const wrapper = mountRow();
		expect(disclosure(wrapper).element.querySelectorAll(INTERACTIVE)).toHaveLength(0);
		const buttons = actions(wrapper);
		expect(buttons).toHaveLength(3);
		for (const button of buttons) {
			expect(button.element.parentElement?.closest(INTERACTIVE)).toBeNull();
		}
		wrapper.unmount();
	});
});

describe('domain row header text', () => {
	const text = (wrapper: VueWrapper) => wrapper.get('[data-testid="sends-as-line"]');

	it('toggles the row on a plain click, on the domain name and on the hint line', async () => {
		const wrapper = mountRow();
		await wrapper.get('p').trigger('click');
		await text(wrapper).trigger('click');
		expect(wrapper.emitted('toggle')).toHaveLength(2);
		wrapper.unmount();
	});

	it('moves focus to the disclosure, so Space and Enter carry on from there', async () => {
		const wrapper = mountRow();
		(document.activeElement as HTMLElement | null)?.blur();
		await wrapper.get('p').trigger('click');
		expect(document.activeElement).toBe(disclosure(wrapper).element);
		disclosure(wrapper).element.blur();
		await text(wrapper).trigger('click');
		expect(document.activeElement).toBe(disclosure(wrapper).element);
		wrapper.unmount();
	});

	it('does not toggle on the click that ends a text selection', async () => {
		const wrapper = mountRow();
		const range = document.createRange();
		range.selectNodeContents(text(wrapper).element);
		const selection = window.getSelection()!;
		selection.removeAllRanges();
		selection.addRange(range);
		expect(selection.toString()).toContain('anyone@mail.example.com');
		await text(wrapper).trigger('click');
		expect(wrapper.emitted('toggle')).toBeUndefined();
		expect(selection.toString()).toContain('anyone@mail.example.com');
		selection.removeAllRanges();
		wrapper.unmount();
	});

	it('is plain text, not a control', () => {
		const wrapper = mountRow();
		expect(text(wrapper).element.closest(INTERACTIVE)).toBeNull();
		expect(wrapper.get('p').element.closest(INTERACTIVE)).toBeNull();
		wrapper.unmount();
	});
});

describe('domain row chevron', () => {
	// Rotated when expanded, which makes it a stacking context painted above the
	// overlay: without this it would swallow the click that should fold the row.
	it.each([false, true])(
		'lets the pointer through to the disclosure (expanded: %s)',
		(isExpanded) => {
			const wrapper = mountRow({ isExpanded });
			const chevron = wrapper.get('svg').element.parentElement!;
			expect(chevron.getAttribute('aria-hidden')).toBe('true');
			expect(chevron.classList.contains('pointer-events-none')).toBe(true);
			wrapper.unmount();
		}
	);
});

describe('domain row actions', () => {
	it.each(['Enter', ' '] as const)(
		'%j on an action runs it and never toggles the row',
		async (key) => {
			const wrapper = mountRow();
			const [forceVerify, verify, remove] = actions(wrapper);
			await press(forceVerify!.element, key);
			await press(verify!.element, key);
			await press(remove!.element, key);
			expect(wrapper.emitted('forceVerify')).toHaveLength(1);
			expect(wrapper.emitted('verify')).toHaveLength(1);
			expect(wrapper.emitted('delete')).toHaveLength(1);
			expect(wrapper.emitted('toggle')).toBeUndefined();
			wrapper.unmount();
		}
	);

	it('Retry on a failed registration does not toggle the row either', async () => {
		const wrapper = mountRow({
			domain: { ...rowProps().domain, status: 'failed', lastRegistrationError: 'Provider refused' },
		});
		await press(actions(wrapper)[1]!.element, 'Enter');
		expect(wrapper.emitted('retryRegistration')).toHaveLength(1);
		expect(wrapper.emitted('toggle')).toBeUndefined();
		wrapper.unmount();
	});
});

describe('domain row accessibility', () => {
	it.each([false, true])(
		'passes axe, nested-interactive included (expanded: %s)',
		async (isExpanded) => {
			const violations = await auditA11y(RecordRow, {
				props: rowProps({ isExpanded }),
				global: { plugins: [createTestI18n()], stubs: panelStubs, mocks: { capitalize } },
			});
			expect(violations).toEqual([]);
		}
	);
});
