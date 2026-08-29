// @vitest-environment happy-dom
/**
 * PostboxContactKeyPanel — what Owlat knows about one correspondent's sealing
 * key, and what a HUMAN knows about it (plan idea 54).
 *
 * The distinction those two sentences draw is the thing being tested. "Trusted
 * key pinned" means only that Owlat has consistently seen the same key since
 * first contact — it survives an attacker who was there from the beginning.
 * "Verified" means a person compared it with its owner. The panel must never let
 * the first read as the second, must attribute the second, and must stop
 * claiming it the moment the key it was about is no longer the key in use.
 */
import { describe, it, expect, beforeAll, vi } from 'vitest';
import { mount } from '@vue/test-utils';

import PostboxContactKeyPanel from '../PostboxContactKeyPanel.vue';
import { createTestI18n, i18nStubs } from '~/__tests__/i18n';

beforeAll(() => {
	Object.assign(globalThis, { useI18n: i18nStubs.useI18n });
});

const PIN = 'AAAA1111BBBB2222CCCC3333DDDD4444EEEE5555';
const OTHER = 'FFFF9999EEEE8888DDDD7777CCCC6666BBBB5555';

const iconStub = { props: ['name'], template: '<span />' };
const verifyPanelStub = {
	props: ['address', 'fingerprint', 'state'],
	template: '<div data-testid="verify-panel-stub" />',
};

type Status = Record<string, unknown>;

const trusted = (over: Status = {}): Status => ({
	outcome: 'trusted',
	pinnedFingerprint: PIN,
	observedFingerprint: PIN,
	discoveredAt: 1_700_000_000_000,
	source: 'wkd',
	expiresAt: 1_800_000_000_000,
	verifiedFingerprint: null,
	verifiedAt: null,
	verifiedByMe: false,
	...over,
});

const mountPanel = (status: Status) =>
	mount(PostboxContactKeyPanel, {
		props: { address: 'bob@b.test', status: status as never },
		global: {
			plugins: [createTestI18n()],
			stubs: { Icon: iconStub, PostboxContactVerifyPanel: verifyPanelStub },
		},
	});

describe('PostboxContactKeyPanel · pinned is not verified', () => {
	it('shows a pinned key as unverified until somebody checks it', () => {
		const wrapper = mountPanel(trusted());
		expect(wrapper.find('[data-testid="contact-key-state"]').text()).toBe('Trusted key pinned');
		expect(wrapper.find('[data-testid="contact-verification-state"]').text()).toBe(
			'Not verified in person'
		);
	});

	it('attributes a verification to you or to a teammate, and dates it', () => {
		const mine = mountPanel(
			trusted({ verifiedFingerprint: PIN, verifiedAt: 1_700_000_500_000, verifiedByMe: true })
		);
		expect(mine.find('[data-testid="contact-verification-state"]').text()).toBe('Verified by you');
		expect(mine.find('[data-testid="contact-verified-on"]').exists()).toBe(true);

		const theirs = mountPanel(
			trusted({ verifiedFingerprint: PIN, verifiedAt: 1_700_000_500_000, verifiedByMe: false })
		);
		expect(theirs.find('[data-testid="contact-verification-state"]').text()).toBe(
			'Verified by a teammate'
		);
	});

	it('stops claiming verification once the key it was about is gone', () => {
		const wrapper = mountPanel(
			trusted({
				pinnedFingerprint: OTHER,
				verifiedFingerprint: PIN,
				verifiedAt: 1_700_000_500_000,
				verifiedByMe: true,
			})
		);
		expect(wrapper.find('[data-testid="contact-verification-state"]').text()).toBe(
			'Verified key no longer in use'
		);
		// The date of a check that no longer applies is noise, so it is not shown.
		expect(wrapper.find('[data-testid="contact-verified-on"]').exists()).toBe(false);
	});
});

describe('PostboxContactKeyPanel · the comparison surface', () => {
	it('stays collapsed until asked for — verifying is a deliberate act', async () => {
		const wrapper = mountPanel(trusted());
		expect(wrapper.find('[data-testid="verify-panel-stub"]').exists()).toBe(false);
		await wrapper.find('[data-testid="contact-verify-toggle"]').trigger('click');
		expect(wrapper.find('[data-testid="verify-panel-stub"]').exists()).toBe(true);
	});

	it('hands the comparison surface the PINNED key, never the observed one', async () => {
		const wrapper = mountPanel(
			trusted({ outcome: 'keyChanged', pinnedFingerprint: PIN, observedFingerprint: OTHER })
		);
		await wrapper.find('[data-testid="contact-verify-toggle"]').trigger('click');
		const panel = wrapper.findComponent(verifyPanelStub);
		// The key we would seal to is the only one worth comparing; the conflicting
		// one is resolved on the key-change banner, not by verifying it here.
		expect(panel.props('fingerprint')).toBe(PIN);
		expect(panel.props('address')).toBe('bob@b.test');
	});

	it('bubbles a recorded verification so the host can re-read the status', async () => {
		const wrapper = mountPanel(trusted());
		await wrapper.find('[data-testid="contact-verify-toggle"]').trigger('click');
		wrapper.findComponent(verifyPanelStub).vm.$emit('changed');
		expect(wrapper.emitted('verification-changed')).toHaveLength(1);
	});

	it('offers nothing to compare for an address with no key at all', () => {
		const wrapper = mountPanel({
			outcome: 'notFound',
			pinnedFingerprint: null,
			observedFingerprint: null,
			discoveredAt: null,
			source: null,
			expiresAt: 1,
			verifiedFingerprint: null,
			verifiedAt: null,
			verifiedByMe: false,
		});
		expect(wrapper.find('[data-testid="contact-key-empty"]').exists()).toBe(true);
		expect(wrapper.find('[data-testid="contact-verify-toggle"]').exists()).toBe(false);
	});
});
