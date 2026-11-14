/**
 * The compact transactional verdict on the transactional pages: the same chip
 * and sentence as the Delivery hub, a fix link for admins, a pointer to who can
 * fix it for members, and distinct loading and error states.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mount } from '@vue/test-utils';
import { computed, ref, type Ref } from 'vue';
import TransactionalReadinessLine from '../TransactionalReadinessLine.vue';
import StreamVerdict from '../StreamVerdict.vue';
import {
	deriveDeliveryReadiness,
	type DeliveryReadiness,
	type ReadinessInput,
} from '~/utils/deliveryReadiness';
import { createTestI18n, expectFullyLocalized, i18nStubs } from '~/__tests__/i18n';

const state = {
	readiness: ref(null) as Ref<DeliveryReadiness | null>,
	isLoading: ref(false),
	error: ref(null) as Ref<Error | null>,
	retry: vi.fn(),
};
const isAdmin = ref(true);

vi.mock('~/composables/useDeliveryReadiness', () => ({
	useDeliveryReadiness: () => ({
		readiness: computed(() => state.readiness.value),
		isLoading: computed(() => state.isLoading.value),
		error: computed(() => state.error.value),
		retry: state.retry,
	}),
}));

function readinessFor(overrides: Partial<ReadinessInput> = {}): DeliveryReadiness {
	return deriveDeliveryReadiness({
		transportConfigured: true,
		hasDomains: true,
		domainVerified: true,
		authComplete: true,
		authMissing: [],
		streamTransport: {
			transactional: { canSend: true, providerLabels: ['Amazon SES'], usesOwnMta: false },
			marketing: { canSend: true, providerLabels: ['Amazon SES'], usesOwnMta: false },
		},
		streamsEnabled: { marketing: false },
		transactionalSender: { address: 'hello@acme.com', isDomainVerified: true },
		...overrides,
	});
}

const global = {
	plugins: [createTestI18n()],
	stubs: {
		DeliveryStreamVerdict: StreamVerdict,
		LazyTransactionalSenderRow: { template: '<p data-testid="sender-row" />' },
		NuxtLink: { props: ['to'], template: '<a :href="to"><slot /></a>' },
		UiButton: {
			emits: ['click'],
			template: '<button type="button" @click="$emit(\'click\')"><slot /></button>',
		},
	},
};

beforeEach(() => {
	vi.stubGlobal('useI18n', i18nStubs.useI18n);
	vi.stubGlobal('usePermissions', () => ({ isAdmin: computed(() => isAdmin.value) }));
	state.readiness.value = null;
	state.isLoading.value = false;
	state.error.value = null;
	state.retry.mockReset();
	isAdmin.value = true;
});

describe('TransactionalReadinessLine', () => {
	it('says what to fix and links an admin to it and to the hub', () => {
		state.readiness.value = readinessFor({
			transactionalSender: { address: null, isDomainVerified: false },
		});
		const wrapper = mount(TransactionalReadinessLine, { global });

		expect(wrapper.text()).toContain('Transactional mail');
		expect(wrapper.text()).toContain('Blocked');
		expect(wrapper.text()).toContain('No sender is set');
		const hrefs = wrapper.findAll('a').map((a) => a.attributes('href'));
		expect(hrefs).toEqual([
			'/dashboard/send/transactional?sender=edit',
			'/dashboard/admin/delivery',
		]);
		// The sender the verdict is about sits under it.
		expect(wrapper.find('[data-testid="sender-row"]').exists()).toBe(true);
		expect(wrapper.find('[role="status"]').text()).toBe('Transactional mail: Blocked');
		expectFullyLocalized(wrapper);
	});

	it('names the transport when transactional mail can go out', () => {
		state.readiness.value = readinessFor();
		const wrapper = mount(TransactionalReadinessLine, { global });

		expect(wrapper.text()).toContain('Ready');
		expect(wrapper.text()).toContain('Transactional mail can go out via Amazon SES.');
	});

	it('tells a member who can fix it instead of linking to admin pages', () => {
		isAdmin.value = false;
		state.readiness.value = readinessFor({
			transactionalSender: { address: null, isDomainVerified: false },
		});
		const wrapper = mount(TransactionalReadinessLine, { global });

		expect(wrapper.findAll('a')).toHaveLength(0);
		expect(wrapper.text()).toContain('An admin can fix this under Delivery health.');
	});

	it('keeps loading and error apart from a verdict', async () => {
		state.isLoading.value = true;
		const loading = mount(TransactionalReadinessLine, { global });
		expect(loading.find('[data-testid="transactional-readiness-loading"]').exists()).toBe(true);
		expect(loading.find('[data-testid="transactional-readiness"]').exists()).toBe(false);

		state.isLoading.value = false;
		state.error.value = new Error('offline');
		const failed = mount(TransactionalReadinessLine, { global });
		expect(failed.find('[data-testid="transactional-readiness-error"]').text()).toContain(
			"Couldn't check whether transactional mail can go out."
		);
		await failed.find('button').trigger('click');
		expect(state.retry).toHaveBeenCalledOnce();
	});

	it('renders nothing when transactional sending is switched off', () => {
		state.readiness.value = readinessFor({ streamsEnabled: { transactional: false } });
		const wrapper = mount(TransactionalReadinessLine, { global });

		expect(wrapper.find('[data-testid="transactional-readiness"]').exists()).toBe(false);
	});
});
