// @vitest-environment happy-dom
/**
 * The delivery strip, mounted against the REAL message catalog.
 *
 * What this guards is the sentence a person reads under a message that did not
 * arrive: the plain-language cause, whose problem it is, and one next action —
 * with the raw SMTP line demoted to collapsed evidence rather than promoted to
 * the headline. A key that never made it into `en.json` would render as its own
 * path, which the catalog assertions below catch.
 */
import { describe, it, expect, beforeAll, vi } from 'vitest';
import { mount } from '@vue/test-utils';

import PostboxDeliveryStrip from '../PostboxDeliveryStrip.vue';
import { createTestI18n, i18nStubs } from '~/__tests__/i18n';
import type { OutboundDelivery } from '~/utils/postboxDeliveryStrip';

const AT = 1_770_000_000_000;

beforeAll(() => {
	// `useI18n` is a Nuxt auto-import in the app; the real one resolves against
	// the instance `global.plugins` installs, so the catalog assertions below
	// read the same English copy a browser paints.
	vi.stubGlobal('useI18n', i18nStubs.useI18n);
});

const iconStub = { props: ['name'], template: '<span />' };

function mountStrip(delivery: OutboundDelivery) {
	return mount(PostboxDeliveryStrip, {
		props: { delivery },
		global: {
			plugins: [createTestI18n()],
			stubs: { Icon: iconStub },
		},
	});
}

const bouncedSend: OutboundDelivery = {
	state: 'partial',
	recipients: [
		{
			idx: 0,
			address: 'ines@northwind.studio',
			state: 'sent',
			sentAt: AT,
			acceptedAt: AT + 60_000,
		},
		{
			idx: 1,
			address: 'jonas@acme.example',
			state: 'bounced',
			sentAt: AT,
			bouncedAt: AT + 90_000,
			bounceMessage: '452 4.2.2 The email account that you tried to reach is over quota',
		},
	],
};

describe('PostboxDeliveryStrip', () => {
	it('names every recipient and what happened to each', () => {
		const text = mountStrip(bouncedSend).text();
		expect(text).toContain('ines@northwind.studio');
		expect(text).toContain('delivered');
		expect(text).toContain('jonas@acme.example');
		expect(text).toContain("couldn't be delivered");
	});

	it('leads with the plain-language cause, not the SMTP string', () => {
		const wrapper = mountStrip(bouncedSend);
		expect(wrapper.text()).toContain("Their mailbox is full, so it couldn't take the message.");
		// The receiver's own words are behind a disclosure, so they never compete
		// with the sentence that actually helps.
		const details = wrapper.find('details');
		expect(details.exists()).toBe(true);
		expect(details.text()).toContain('over quota');
	});

	it('tells the sender this one is not their fault', () => {
		expect(mountStrip(bouncedSend).text()).toContain('Nothing on your side');
	});

	it('offers exactly one next action', () => {
		expect(mountStrip(bouncedSend).text()).toContain(
			'Try again in a day, or reach them another way'
		);
	});

	it('emits a resend for the failed recipient only', async () => {
		const wrapper = mountStrip(bouncedSend);
		const resend = wrapper
			.findAll('button')
			.find((b) => b.text().includes('Resend to jonas@acme.example only'));
		expect(resend).toBeDefined();
		await resend!.trigger('click');
		expect(wrapper.emitted('resend')).toEqual([[['jonas@acme.example']]]);
	});

	it('renders nothing at all for a single recipient that simply got the mail', () => {
		const wrapper = mountStrip({
			state: 'sent',
			recipients: [
				{ idx: 0, address: 'ines@northwind.studio', state: 'sent', sentAt: AT, acceptedAt: AT },
			],
		});
		expect(wrapper.find('section').exists()).toBe(false);
	});

	it('offers no resend when every recipient took the message', () => {
		const wrapper = mountStrip({
			state: 'sent',
			recipients: [
				{ idx: 0, address: 'ines@northwind.studio', state: 'sent', acceptedAt: AT },
				{ idx: 1, address: 'kim@northwind.studio', state: 'sent', acceptedAt: AT },
			],
		});
		expect(wrapper.find('section').exists()).toBe(true);
		expect(wrapper.findAll('button')).toHaveLength(0);
	});

	it('reads a DMARC rejection as the sender’s own setup', () => {
		const text = mountStrip({
			state: 'bounced',
			recipients: [
				{
					idx: 0,
					address: 'jonas@acme.example',
					state: 'bounced',
					bouncedAt: AT,
					bounceMessage:
						"550 5.7.1 Unauthenticated email from acme.example is not accepted due to domain's DMARC policy.",
				},
			],
		}).text();
		expect(text).toContain('Something on your side');
		expect(text).toContain("doesn't accept mail sent this way from your domain");
	});
});
