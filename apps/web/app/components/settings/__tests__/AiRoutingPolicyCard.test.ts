// @vitest-environment happy-dom
/**
 * The AI routing policy card (U2): every switch with its one-line
 * explanation and its default named, the shadow allowance in dollars as the
 * form stands, and a save that waits for a change and a valid form. It
 * reports its unsaved state to the page's unsaved-changes guard.
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
import { nextTick, ref, type Ref } from 'vue';
import { ROUTING_SWITCH_KEYS, resolveRoutingPolicy } from '@owlat/shared/aiRouting';
import { createTestI18n, expectFullyLocalized, i18nStubs } from '~/__tests__/i18n';

vi.mock('@owlat/api', () => ({
	api: { aiRouting: { policy: { get: 'policy.get', update: 'policy.update' } } },
}));

const AiRoutingPolicyCard = (await import('../AiRoutingPolicyCard.vue')).default;

let data: Ref<Record<string, unknown> | null>;
const run = vi.fn();

beforeAll(() => {
	Object.assign(globalThis, { useI18n: i18nStubs.useI18n });
	vi.stubGlobal('useToast', () => ({ showToast: vi.fn() }));
	vi.stubGlobal('useOrganizationQuery', () => ({
		data,
		isLoading: ref(false),
		error: ref(null),
		refetch: vi.fn(),
	}));
	vi.stubGlobal('useBackendOperation', () => ({ run, isLoading: ref(false) }));
});

beforeEach(() => {
	run.mockReset();
	run.mockImplementation(async (args: Record<string, unknown>) => ({
		ok: true,
		result: resolveRoutingPolicy({ ...args, policyVersion: 1, updatedAt: 1 }),
	}));
	data = ref({
		policy: resolveRoutingPolicy(null),
		isStored: false,
		dailyCeilingUsd: 25,
	});
});

/** A select as a native one, so a test can pick a value. */
const SelectStub = {
	props: ['modelValue', 'options', 'ariaLabel'],
	emits: ['update:modelValue'],
	template: `<select :aria-label="ariaLabel" :value="modelValue" @change="$emit('update:modelValue', $event.target.value)">
		<option v-for="o in options" :key="o.value" :value="o.value">{{ o.label }}</option>
	</select>`,
};
const InputStub = {
	props: ['modelValue', 'label', 'error', 'helpText'],
	emits: ['update:modelValue'],
	template: `<label>{{ label }}<input :value="modelValue" @input="$emit('update:modelValue', $event.target.value)" /><span class="help">{{ helpText }}</span><span v-if="error" class="err">{{ error }}</span></label>`,
};

function mountCard() {
	return mount(AiRoutingPolicyCard, {
		global: {
			plugins: [createTestI18n()],
			stubs: {
				UiCard: { template: '<section><slot /></section>' },
				UiQueryBoundary: { template: '<div><slot /></div>' },
				UiSkeleton: true,
				UiSelect: SelectStub,
				UiInput: InputStub,
				UiSwitch: true,
				Icon: true,
				UiButton: {
					props: ['disabled'],
					emits: ['click'],
					template: '<button :disabled="disabled" @click="$emit(\'click\')"><slot /></button>',
				},
			},
		},
	});
}

describe('AiRoutingPolicyCard', () => {
	it('shows every switch, its explanation and its default, all off', () => {
		const w = mountCard();
		const selects = w.findAll('select');
		expect(selects).toHaveLength(ROUTING_SWITCH_KEYS.length);
		for (const select of selects) expect((select.element as HTMLSelectElement).value).toBe('off');
		expect(w.text()).toContain('Off (default)');
		expect(w.text()).toContain('It records its answer and changes nothing.');
		expect(w.text()).toContain('the safety checks, the AI check included, still run.');
		expect(w.text()).toContain('Daily AI spend ceiling: $25.00.');
		expect(w.get('[data-testid="ai-routing-shadow-allowance"]').text()).toBe(
			'No switch is in shadow, so shadow runs spend nothing.'
		);
		expect(w.get('[data-testid="ai-routing-version"]').text()).toBe(
			'Not saved yet. The defaults apply.'
		);
		expect(w.get('[data-testid="ai-routing-save"]').attributes('disabled')).toBeDefined();
		expectFullyLocalized(w);
	});

	it('states the shadow allowance once a switch is in shadow, and saves the change', async () => {
		const w = mountCard();
		await w.get('[data-testid="ai-routing-switch-triageBundle"]').setValue('shadow');
		expect(w.get('[data-testid="ai-routing-shadow-allowance"]').text()).toBe(
			'Shadow runs may spend up to $1.25 a day.'
		);
		expect(w.emitted('dirty')?.at(-1)).toEqual([true]);
		const save = w.get('[data-testid="ai-routing-save"]');
		expect(save.attributes('disabled')).toBeUndefined();
		await save.trigger('click');
		await flushPromises();
		expect(run).toHaveBeenCalledWith({ expectedPolicyVersion: 0, triageBundle: 'shadow' });
		expect(w.emitted('dirty')?.at(-1)).toEqual([false]);
	});

	it('asks for a cap before shadowing with no daily ceiling, and will not save without it', async () => {
		data.value = { ...data.value, dailyCeilingUsd: 0 };
		const w = mountCard();
		await nextTick();
		expect(w.text()).toContain('No daily AI spend ceiling is set.');
		await w.get('[data-testid="ai-routing-switch-clarifyNecessity"]').setValue('shadow');
		expect(w.text()).toContain('Required while a switch is in shadow and no daily ceiling is set.');
		expect(w.get('[data-testid="ai-routing-shadow-allowance"]').text()).toBe(
			'Set a spending cap. With no daily ceiling, shadow runs need one.'
		);
		expect(w.get('[data-testid="ai-routing-save"]').attributes('disabled')).toBeDefined();
	});

	it('names the stored version', () => {
		data.value = {
			policy: resolveRoutingPolicy({ policyVersion: 4, updatedAt: Date.UTC(2026, 9, 7) }),
			isStored: true,
			dailyCeilingUsd: 25,
		};
		expect(mountCard().get('[data-testid="ai-routing-version"]').text()).toMatch(
			/^Version 4, saved /
		);
	});
});
