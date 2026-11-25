/**
 * Deliverability Center → where alerts go: one summary line naming every
 * channel, and one row per channel with the action that fixes it. The states
 * the demo stack cannot show (push not set up, no device, no sender, the
 * caller's switch off, the desktop app) are pinned here.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mount } from '@vue/test-utils';
import { computed, ref } from 'vue';
import { createTestI18n, expectFullyLocalized, i18nStubs } from '~/__tests__/i18n';
import DeliverabilityAlertChannels from '../DeliverabilityAlertChannels.vue';

interface Channels {
	email: { recipientCount: number; isSenderConfigured: boolean; isOnOwnMta: boolean };
	inApp: { recipientCount: number };
	push: { isConfigured: boolean; deviceCount: number };
	webhook: { isFeatureOn: boolean; count: number; cleartextCount: number };
	me: { isSwitchOn: boolean; deviceCount: number };
}

const READY: Channels = {
	email: { recipientCount: 2, isSenderConfigured: true, isOnOwnMta: false },
	inApp: { recipientCount: 2 },
	push: { isConfigured: true, deviceCount: 1 },
	webhook: { isFeatureOn: true, count: 1, cleartextCount: 0 },
	me: { isSwitchOn: true, deviceCount: 1 },
};

const data = ref<Channels | undefined>(undefined);
const save = vi.fn(async () => ({ ok: true }));
const isDesktop = ref(false);

beforeEach(() => {
	vi.clearAllMocks();
	data.value = undefined;
	isDesktop.value = false;
	vi.stubGlobal('useI18n', i18nStubs.useI18n);
	vi.stubGlobal('computed', computed);
	vi.stubGlobal('ref', ref);
	vi.stubGlobal('useOrganizationQuery', () => ({ data }));
	vi.stubGlobal('useBackendOperation', () => ({ run: save }));
	vi.stubGlobal('useDesktopContext', () => ({ isDesktop }));
});

function mountCard(channels: Channels | null = READY) {
	data.value = channels ?? undefined;
	return mount(DeliverabilityAlertChannels, {
		global: {
			plugins: [createTestI18n()],
			stubs: {
				DeliveryDeliverabilityAlertTestPanel: { template: '<div data-testid="test-panel" />' },
				UiButton: {
					props: ['to', 'href', 'loading'],
					emits: ['click'],
					template: '<a :data-to="to" :data-href="href" @click="$emit(\'click\')"><slot /></a>',
				},
			},
		},
	});
}

function actionTargets(wrapper: ReturnType<typeof mountCard>): string[] {
	return wrapper
		.findAll('a')
		.map((link) => link.attributes('data-to') ?? link.attributes('data-href') ?? '');
}

describe('DeliverabilityAlertChannels', () => {
	it('renders nothing until the channels are known', () => {
		expect(mountCard(null).find('section').exists()).toBe(false);
	});

	it('names every channel in one line', () => {
		const wrapper = mountCard();
		expectFullyLocalized(wrapper);
		expect(wrapper.get('[data-testid="alert-channels-summary"]').text()).toBe(
			'Email to 2 people · In app for 2 people · Push on 1 device · Webhook to 1 endpoint'
		);
		expect(wrapper.find('[data-testid="test-panel"]').exists()).toBe(true);
	});

	it('says the email may not arrive when it leaves through the server the checks watch', () => {
		const wrapper = mountCard({ ...READY, email: { ...READY.email, isOnOwnMta: true } });
		expect(wrapper.get('[data-testid="alert-channel-email"]').text()).toContain(
			'may not arrive when that server is the problem'
		);
	});

	it('offers one fix per channel when nothing reaches anyone', () => {
		const wrapper = mountCard({
			email: { recipientCount: 2, isSenderConfigured: false, isOnOwnMta: false },
			inApp: { recipientCount: 0 },
			push: { isConfigured: false, deviceCount: 0 },
			webhook: { isFeatureOn: true, count: 0, cleartextCount: 0 },
			me: { isSwitchOn: false, deviceCount: 0 },
		});
		expectFullyLocalized(wrapper);
		expect(wrapper.get('[data-testid="alert-channels-summary"]').text()).toBe(
			'No email · Nobody in the app · No push · Webhook not set'
		);
		expect(wrapper.get('[data-testid="alert-channel-email"]').text()).toContain(
			'no alert email goes out'
		);
		expect(actionTargets(wrapper)).toEqual([
			'/dashboard/admin/delivery/transport',
			'',
			'https://docs.owlat.app/developer/environment-variables#optional-web-push-notifications',
			'/dashboard/admin/delivery/webhooks?preset=deliverability-alerts',
		]);
		expect(wrapper.get('[data-testid="alert-channel-webhook"]').text()).toContain(
			'No webhook receives deliverability alerts'
		);
		expect(wrapper.get('[data-testid="alert-channel-my-switch"]').text()).toBe('Turn on for me');
	});

	it('sends the caller to turn on push here when none of their devices has it', () => {
		const wrapper = mountCard({ ...READY, me: { isSwitchOn: true, deviceCount: 0 } });
		expect(actionTargets(wrapper)).toContain('/dashboard/preferences/device#push');
	});

	it('offers no browser push on the desktop app, which notifies natively', () => {
		isDesktop.value = true;
		const wrapper = mountCard({ ...READY, me: { isSwitchOn: true, deviceCount: 0 } });
		expect(actionTargets(wrapper)).not.toContain('/dashboard/preferences/device#push');
		expect(wrapper.text()).toContain('system notifications');
	});

	it('turns the caller’s own switch off and back on', async () => {
		const wrapper = mountCard();
		const toggle = wrapper.get('[data-testid="alert-channel-my-switch"]');
		expect(toggle.text()).toBe('Turn off for me');
		await toggle.trigger('click');
		expect(save).toHaveBeenCalledWith({ preference: 'deliverabilityAlerts', enabled: false });

		const off = mountCard({ ...READY, me: { isSwitchOn: false, deviceCount: 1 } });
		await off.get('[data-testid="alert-channel-my-switch"]').trigger('click');
		expect(save).toHaveBeenLastCalledWith({ preference: 'deliverabilityAlerts', enabled: true });
	});

	it('sends a configured webhook to the webhook list, and says when webhooks are off', () => {
		expect(actionTargets(mountCard())).toContain('/dashboard/admin/delivery/webhooks');
		const off = mountCard({
			...READY,
			webhook: { isFeatureOn: false, count: 0, cleartextCount: 0 },
		});
		expect(off.get('[data-testid="alert-channel-webhook"]').text()).toContain('turned off');
		expect(actionTargets(off)).not.toContain(
			'/dashboard/admin/delivery/webhooks?preset=deliverability-alerts'
		);
	});

	it('says an alert webhook with an http URL gets no alerts, and links to it', () => {
		const only = mountCard({
			...READY,
			webhook: { isFeatureOn: true, count: 0, cleartextCount: 1 },
		});
		expectFullyLocalized(only);
		expect(only.get('[data-testid="alert-channels-summary"]').text()).toContain(
			'Webhook needs HTTPS'
		);
		expect(only.get('[data-testid="alert-channel-webhook"]').text()).toBe(
			'1 webhook subscribed to alerts has an http:// URL and gets no alerts until its URL starts with https://.'
		);
		expect(actionTargets(only)).toContain('/dashboard/admin/delivery/webhooks');
		expect(actionTargets(only)).not.toContain(
			'/dashboard/admin/delivery/webhooks?preset=deliverability-alerts'
		);

		const mixed = mountCard({
			...READY,
			webhook: { isFeatureOn: true, count: 1, cleartextCount: 2 },
		});
		expect(mixed.get('[data-testid="alert-channel-webhook"]').text()).toBe(
			'Sent to 1 webhook, signed and retried. 2 webhooks subscribed to alerts have an http:// URL and get no alerts until their URLs start with https://.'
		);
	});
});
