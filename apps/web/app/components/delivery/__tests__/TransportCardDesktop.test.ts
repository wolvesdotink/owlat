/**
 * The delivery hub's transport card in the desktop app. Its "Set up sending" /
 * "Change transport" button leads to the transport editor, whose test and
 * apply steps post to server routes the desktop build does not have. On
 * desktop the card says the transport is set up on the instance and offers its
 * transport page in the system browser; the read-only state stays.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import { ref } from 'vue';
import TransportCard from '../TransportCard.vue';
import { createTestI18n, i18nStubs } from '~/__tests__/i18n';
import { DESKTOP_SITE_URL, onDesktop } from '~/__tests__/desktopRuntimeFixture';
import en from '~~/i18n/locales/en.json';

const openExternal = vi.hoisted(() => vi.fn(async (_url: string) => undefined));
vi.mock('@owlat/desktop/src/shell', () => ({ openExternal }));

const SUMMARY = {
	provider: null,
	isKnownProvider: false,
	canSend: false,
	advancedRoutingActive: false,
	health: null,
	infrastructure: null,
};

beforeEach(() => {
	openExternal.mockClear();
	vi.stubGlobal('useI18n', i18nStubs.useI18n);
	vi.stubGlobal('formatCompactRelativeTime', () => '');
	vi.stubGlobal('useOrganizationQuery', () => ({
		data: ref(SUMMARY),
		isLoading: ref(false),
		error: ref(null),
		refetch: vi.fn(),
	}));
});

function mountCard() {
	return mount(TransportCard, {
		global: {
			plugins: [createTestI18n()],
			stubs: {
				UiCard: { template: '<section><slot /></section>' },
				UiIconBox: true,
				NuxtLink: { props: ['to'], template: '<a :href="to"><slot /></a>' },
			},
		},
	});
}

describe('the hub transport card', () => {
	it('links the transport editor in the browser build', () => {
		const wrapper = mountCard();
		expect(wrapper.text()).toContain(en.components.delivery.transportCard.setUpSending);
		expect(wrapper.find('[data-testid="instance-transport-notice"]').exists()).toBe(false);
	});

	it('on desktop, says where sending is set up and opens it in the browser', async () => {
		onDesktop();
		const wrapper = mountCard();

		expect(wrapper.text()).not.toContain(en.components.delivery.transportCard.setUpSending);
		const notice = wrapper.find('[data-testid="instance-transport-notice"]');
		expect(notice.text()).toContain(en.components.delivery.instanceTransport.body);
		// The read-only verdict is still there.
		expect(wrapper.text()).toContain(en.components.delivery.transportCard.eyebrow);

		await notice.find('button').trigger('click');
		await flushPromises();
		expect(openExternal).toHaveBeenCalledWith(
			`${DESKTOP_SITE_URL}/dashboard/admin/delivery/transport`
		);
	});
});
