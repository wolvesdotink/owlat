/**
 * The Delivery hub's readiness panel: one verdict per kind of mail, the open
 * gates labelled with the stream and transport they belong to, the passed ones
 * one click away, and loading, error and verdict states kept apart.
 *
 * The fold itself is covered in `utils/__tests__/deliveryReadiness.test.ts`;
 * here it runs for real on fixed inputs, so the panel is asserted on what it
 * renders from a real verdict.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mount } from '@vue/test-utils';
import { computed, ref, type Ref } from 'vue';
import ReadinessPanel from '../ReadinessPanel.vue';
import StreamVerdict from '../StreamVerdict.vue';
import {
	deriveDeliveryReadiness,
	type DeliveryReadiness,
	type ReadinessInput,
	type StreamTransportFacts,
} from '~/utils/deliveryReadiness';
import { createTestI18n, expectFullyLocalized, i18nStubs } from '~/__tests__/i18n';

const state = {
	readiness: ref(null) as Ref<DeliveryReadiness | null>,
	isLoading: ref(false),
	error: ref(null) as Ref<Error | null>,
	retry: vi.fn(),
};

vi.mock('~/composables/useDeliveryReadiness', () => ({
	useDeliveryReadiness: () => ({
		readiness: computed(() => state.readiness.value),
		isLoading: computed(() => state.isLoading.value),
		error: computed(() => state.error.value),
		retry: state.retry,
	}),
}));

const ownMta: StreamTransportFacts = {
	canSend: true,
	providerLabels: ['Owlat MTA'],
	usesOwnMta: true,
};

function readinessFor(overrides: Partial<ReadinessInput> = {}): DeliveryReadiness {
	return deriveDeliveryReadiness({
		transportConfigured: true,
		hasDomains: true,
		domainVerified: true,
		authComplete: true,
		authMissing: [],
		streamTransport: { transactional: ownMta, marketing: ownMta },
		mailServer: 'healthy',
		defaultSender: { address: 'hello@acme.com', isDomainVerified: true },
		...overrides,
	});
}

const global = {
	plugins: [createTestI18n()],
	stubs: {
		UiCard: { template: '<section><slot /></section>' },
		UiIconBox: true,
		UiQueryBoundary: {
			props: ['error', 'errorMessage'],
			emits: ['retry'],
			template:
				'<div data-testid="query-error">{{ errorMessage }}<button type="button" @click="$emit(\'retry\')">retry</button></div>',
		},
		UiDisclosure: {
			props: ['modelValue', 'label'],
			emits: ['update:modelValue'],
			template:
				'<div><button type="button" data-testid="disclosure" :aria-expanded="modelValue" @click="$emit(\'update:modelValue\', !modelValue)">{{ label }}</button><div v-if="modelValue"><slot /></div></div>',
		},
		DeliveryStreamVerdict: StreamVerdict,
		NuxtLink: { props: ['to'], template: '<a :href="to"><slot /></a>' },
	},
};

beforeEach(() => {
	vi.stubGlobal('useI18n', i18nStubs.useI18n);
	state.readiness.value = null;
	state.isLoading.value = false;
	state.error.value = null;
	state.retry.mockReset();
});

describe('ReadinessPanel', () => {
	it('leads with one verdict per stream, each named in words', () => {
		state.readiness.value = readinessFor({
			defaultSender: { address: null, isDomainVerified: false },
		});
		const wrapper = mount(ReadinessPanel, { global });

		const transactional = wrapper.find('[data-testid="stream-verdict-transactional"]');
		expect(transactional.text()).toContain('Transactional');
		expect(transactional.text()).toContain('Blocked');
		expect(transactional.text()).toContain('No default sender is set');
		expect(transactional.find('a').attributes('href')).toBe('/dashboard/admin/instance/general');

		const marketing = wrapper.find('[data-testid="stream-verdict-marketing"]');
		expect(marketing.text()).toContain('Ready');
		expect(marketing.text()).toContain('Campaigns can go out via Owlat MTA.');
		expectFullyLocalized(wrapper);
	});

	it('labels an open gate with its stream and transport', () => {
		state.readiness.value = readinessFor({ warmupHalted: true });
		const wrapper = mount(ReadinessPanel, { global });

		const open = wrapper.find('[data-testid="readiness-open-gates"]');
		expect(open.text()).toContain("Today's capacity");
		expect(open.text()).toContain('Marketing only · via Your own mail server');
		expect(open.text()).toContain('Warm-up is halted');
	});

	it('keeps the passed gates one click away', async () => {
		state.readiness.value = readinessFor();
		const wrapper = mount(ReadinessPanel, { global });

		expect(wrapper.find('[data-testid="readiness-open-gates"]').exists()).toBe(false);
		expect(wrapper.find('[data-testid="readiness-passed-gates"]').exists()).toBe(false);
		await wrapper.find('[data-testid="disclosure"]').trigger('click');
		const passed = wrapper.find('[data-testid="readiness-passed-gates"]');
		expect(passed.text()).toContain('Mail server');
		expect(passed.text()).toContain('Default sender');
	});

	it('announces both verdicts in a status region, so a re-check is heard', () => {
		state.readiness.value = readinessFor({ mailServer: 'unreachable' });
		const wrapper = mount(ReadinessPanel, { global });

		expect(wrapper.find('[role="status"]').text()).toBe(
			'Transactional: Blocked. Marketing: Blocked.'
		);
	});

	it('shows a skeleton while loading, not a verdict', () => {
		state.isLoading.value = true;
		const wrapper = mount(ReadinessPanel, { global });

		expect(wrapper.find('[aria-busy="true"]').exists()).toBe(true);
		expect(wrapper.find('[data-testid="stream-verdict-transactional"]').exists()).toBe(false);
	});

	it('shows the error with a retry instead of a verdict when a read failed', async () => {
		state.error.value = new Error('offline');
		const wrapper = mount(ReadinessPanel, { global });

		expect(wrapper.find('[data-testid="query-error"]').text()).toContain(
			"Couldn't check delivery readiness"
		);
		expect(wrapper.find('[data-testid="stream-verdict-transactional"]').exists()).toBe(false);
		await wrapper.find('[data-testid="query-error"] button').trigger('click');
		expect(state.retry).toHaveBeenCalledOnce();
	});
});
