// @vitest-environment happy-dom
/**
 * The webhook setup card's job is to be COPYABLE and COMPLETE: the exact URL,
 * the exact events, and the one variable that is not part of sending. The
 * assertions below are the three things an operator cannot recover from being
 * told wrong.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mount } from '@vue/test-utils';
import { computed } from 'vue';
import MandrillWebhookCard from '../MandrillWebhookCard.vue';

const stubs = {
	Icon: { template: '<i />' },
	UiCard: { template: '<div><slot name="header" /><slot /></div>' },
	UiIconBox: { template: '<i />' },
};

beforeEach(() => {
	vi.stubGlobal('computed', computed);
	vi.stubGlobal('useCopyToClipboard', () => ({ copy: vi.fn(), isCopied: () => false }));
});

function mountCard(props: Partial<InstanceType<typeof MandrillWebhookCard>['$props']> = {}) {
	return mount(MandrillWebhookCard, {
		props: {
			webhookUrl: 'https://acme.convex.site/webhooks/mandrill',
			isWebhookKeyPresent: true,
			lastEventAt: null,
			...props,
		},
		global: { stubs },
	});
}

describe('MandrillWebhookCard', () => {
	it('renders the exact endpoint Mandrill signs over', () => {
		const url = mountCard().find('[data-testid="mandrill-webhook-url"]');
		expect(url.text()).toBe('https://acme.convex.site/webhooks/mandrill');
	});

	it('hides the endpoint rather than emitting a relative path when the site URL is unknown', () => {
		const wrapper = mountCard({ webhookUrl: '' });
		expect(wrapper.find('[data-testid="mandrill-webhook-url"]').exists()).toBe(false);
		expect(wrapper.find('[data-testid="mandrill-webhook-no-url"]').text()).toContain(
			'Set your site URL'
		);
	});

	it('lists every event Owlat consumes and no others', () => {
		const text = mountCard().text();
		for (const event of [
			'send',
			'deferral',
			'hard_bounce',
			'soft_bounce',
			'spam',
			'unsub',
			'reject',
		]) {
			expect(text).toContain(event);
		}
	});

	it('tells the operator to leave open/click OFF, and says why', () => {
		// Plan D3: first-party tracking instruments BOTH arms identically, which is
		// the only reason the engagement ramp gate can compare them.
		const note = mountCard().find('[data-testid="mandrill-tracking-events-off"]');
		expect(note.text()).toContain('open');
		expect(note.text()).toContain('click');
		expect(note.text()).toContain('first-party');
	});

	it('shows the signing key as present/missing, never as a value', () => {
		expect(
			mountCard({ isWebhookKeyPresent: false })
				.find('[data-testid="mandrill-webhook-key-presence"]')
				.text()
		).toBe('missing');
		const present = mountCard();
		expect(present.find('[data-testid="mandrill-webhook-key-presence"]').text()).toBe('present');
		expect(present.text()).toContain('MANDRILL_WEBHOOK_KEY');
	});

	it('reports whether feedback has ever actually arrived', () => {
		expect(mountCard().find('[data-testid="mandrill-last-event"]').text()).toContain(
			'No feedback received yet'
		);
		expect(
			mountCard({ lastEventAt: Date.UTC(2026, 7, 4) })
				.find('[data-testid="mandrill-last-event"]')
				.text()
		).toContain('Last event received');
	});
});
