/**
 * The item coverage gate's setting (AutonomyItemCoverage): it shows the stored
 * state, writes `isItemCoverageEnforced` when switched, and says so. Reset puts
 * an enforced check back to off through the same write.
 */
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { defineComponent, h, ref } from 'vue';
import { flushPromises, mount } from '@vue/test-utils';
import { createTestI18n, expectFullyLocalized, i18nStubs } from '~/__tests__/i18n';

vi.mock('@owlat/api', () => ({
	api: { agentConfigMutations: { updateConfig: 'agentConfigMutations.updateConfig' } },
}));

const run = vi.fn(async (_args: unknown) => ({ ok: true }));
const showToast = vi.fn();
const isLoading = ref(false);

beforeAll(() => {
	Object.assign(globalThis, {
		useI18n: i18nStubs.useI18n,
		useToast: () => ({ showToast }),
		useBackendOperation: () => ({ run, isLoading }),
	});
});

const { default: AutonomyItemCoverage } = await import('../AutonomyItemCoverage.vue');

const SwitchStub = defineComponent({
	props: { modelValue: Boolean, label: { type: String, default: '' } },
	emits: ['update:modelValue'],
	setup:
		(props, { emit }) =>
		() =>
			h('button', {
				role: 'switch',
				'aria-checked': String(props.modelValue),
				'aria-label': props.label,
				onClick: () => emit('update:modelValue', !props.modelValue),
			}),
});

function mountCard(enforced: boolean) {
	return mount(AutonomyItemCoverage, {
		props: { enforced },
		global: {
			plugins: [createTestI18n()],
			stubs: {
				UiCard: { template: '<div><slot /></div>' },
				UiIconBox: true,
				UiSwitch: SwitchStub,
				Icon: true,
			},
		},
	});
}

describe('AutonomyItemCoverage', () => {
	it('is off by default and turns enforcement on', async () => {
		const w = mountCard(false);
		expect(w.text()).toContain('Hold replies that miss an open item');
		expect(w.get('[role="switch"]').attributes('aria-checked')).toBe('false');
		expectFullyLocalized(w);
		await w.get('[role="switch"]').trigger('click');
		await flushPromises();
		expect(run).toHaveBeenCalledWith({ isItemCoverageEnforced: true });
		expect(showToast).toHaveBeenCalledWith('Item check saved');
	});

	it('turns it off again', async () => {
		run.mockClear();
		const w = mountCard(true);
		await w.get('[role="switch"]').trigger('click');
		expect(run).toHaveBeenCalledWith({ isItemCoverageEnforced: false });
	});

	it('has no reset marker while off, the default', () => {
		expect(mountCard(false).find('[data-testid="setting-reset"]').exists()).toBe(false);
	});

	it('resets an enforced check to off through the same write', async () => {
		run.mockClear();
		const w = mountCard(true);
		const reset = w.get('[data-testid="setting-reset"] button');
		expect(reset.attributes('aria-label')).toBe(
			'Reset Hold replies that miss an open item to its default'
		);
		await reset.trigger('click');
		await flushPromises();
		expect(run).toHaveBeenCalledWith({ isItemCoverageEnforced: false });
	});

	it('holds the reset while a write is in flight', () => {
		isLoading.value = true;
		try {
			const w = mountCard(true);
			expect(w.get('[data-testid="setting-reset"] button').attributes('disabled')).toBeDefined();
		} finally {
			isLoading.value = false;
		}
	});
});
