// @vitest-environment happy-dom
/**
 * The one-click preset: six writes, in order, with the D8 warning beside them.
 *
 * What this pins is the SHAPE that lands — three `adaptive_mix` routes over
 * `[mta, mandrill]` with Mandrill as the fallback relay, then three
 * `conservative` ramp presets — and the two ways it declines to write: a
 * pre-flight refusal in the mutation's own words, and a stop at the first
 * failure that says which half landed.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mount } from '@vue/test-utils';
import { nextTick, ref } from 'vue';
import { getFunctionName, type FunctionReference } from 'convex/server';
import { api } from '@owlat/api';
import type { MigrationRouteView, MigrationTransportEntry } from '~/utils/mandrillMigration';
import { createTestI18n, i18nStubs } from '~/__tests__/i18n';

const stubs = {
	Icon: { template: '<i />' },
	NuxtLink: { template: '<a><slot /></a>' },
	DeliveryReferenceRelayNotice: { template: '<div data-testid="relay-notice-stub" />' },
	UiButton: {
		props: ['disabled', 'variant'],
		emits: ['click'],
		template: '<button :disabled="disabled" @click="$emit(\'click\')"><slot /></button>',
	},
};

const SET_ROUTE = getFunctionName(api.providerRoutes.setRoute);
const SET_PRESET = getFunctionName(api.delivery.rampControls.setStreamPreset);

let writes: { name: string; args: Record<string, unknown> }[];
/** Operation name → what `run` resolves to. `undefined` means "it refused". */
let outcomes: Map<string, unknown>;

function catalog(over: Partial<Record<string, boolean>> = {}): MigrationTransportEntry[] {
	const availability: Record<string, boolean> = { mta: true, mandrill: true, ...over };
	return Object.entries(availability).map(([kind, isAvailable]) => ({
		kind,
		label: kind,
		isAvailable,
	}));
}

async function mountStep(props: Partial<Record<string, unknown>> = {}) {
	vi.stubGlobal('useI18n', i18nStubs.useI18n);
	vi.stubGlobal('useBackendOperation', (operation: FunctionReference<'mutation'>) => {
		const name = getFunctionName(operation);
		return {
			run: vi.fn(async (args: Record<string, unknown>) => {
				writes.push({ name, args });
				return outcomes.has(JSON.stringify([name, args]))
					? outcomes.get(JSON.stringify([name, args]))
					: { ok: true };
			}),
			isLoading: ref(false),
			inlineError: ref(null),
		};
	});
	const component = (await import('../MigrationPresetStep.vue')).default;
	return mount(component, {
		props: { catalog: catalog(), routes: [] as MigrationRouteView[], isApplied: false, ...props },
		global: { plugins: [createTestI18n()], stubs },
	});
}

beforeEach(() => {
	writes = [];
	outcomes = new Map();
});

afterEach(() => {
	vi.resetModules();
});

async function apply(wrapper: Awaited<ReturnType<typeof mountStep>>): Promise<void> {
	await wrapper.find('[data-testid="migration-preset-apply"]').trigger('click');
	await nextTick();
	await nextTick();
	await nextTick();
	await nextTick();
	await nextTick();
	await nextTick();
	await nextTick();
}

describe('the preset writes the migration shape', () => {
	it('sets all three message types, then all three ramp paces', async () => {
		const wrapper = await mountStep();
		await apply(wrapper);

		expect(writes.map((write) => write.name)).toEqual([
			SET_ROUTE,
			SET_ROUTE,
			SET_ROUTE,
			SET_PRESET,
			SET_PRESET,
			SET_PRESET,
		]);
		expect(writes.slice(0, 3).map((write) => write.args.messageType)).toEqual([
			'transactional',
			'campaign',
			'automation',
		]);
		expect(writes.slice(3).map((write) => write.args)).toEqual([
			{ stream: 'transactional', preset: 'conservative' },
			{ stream: 'campaign', preset: 'conservative' },
			{ stream: 'automation', preset: 'conservative' },
		]);
	});

	it('names Mandrill as the reference arm and the fallback relay', async () => {
		const wrapper = await mountStep();
		await apply(wrapper);

		for (const write of writes.slice(0, 3)) {
			expect(write.args.strategy).toBe('adaptive_mix');
			expect(write.args.providers).toEqual([
				{ providerType: 'mta', isEnabled: true },
				{ providerType: 'mandrill', isEnabled: true },
			]);
			expect(write.args.deliverabilityFallback).toEqual({
				isEnabled: true,
				relayProviderType: 'mandrill',
				isWarmupOverflowEnabled: false,
			});
		}
		expect(wrapper.emitted('applied')).toHaveLength(1);
	});

	it('lists what landed', async () => {
		const wrapper = await mountStep();
		await apply(wrapper);
		const applied = wrapper.find('[data-testid="migration-preset-applied"]').text();
		expect(applied).toContain('campaign route applied');
		expect(applied).toContain('automation ramp pace applied');
	});
});

describe('the preset declines to write', () => {
	it('pre-flights an unconnected relay in the mutation’s own words', async () => {
		const wrapper = await mountStep({ catalog: catalog({ mandrill: false }) });
		expect(wrapper.find('[data-testid="migration-preset-preflight"]').text()).toContain(
			'MANDRILL_API_KEY'
		);
		expect(
			wrapper.find('[data-testid="migration-preset-apply"]').attributes('disabled')
		).toBeDefined();
		await apply(wrapper);
		expect(writes).toHaveLength(0);
	});

	it('stays disabled while an earlier step is outstanding', async () => {
		const wrapper = await mountStep({
			isBlocked: true,
			blockedReason: 'Finish Mandrill’s domain verification first.',
		});
		expect(wrapper.find('[data-testid="migration-preset-blocked"]').text()).toContain(
			'domain verification'
		);
		await apply(wrapper);
		expect(writes).toHaveLength(0);
	});

	it('stops at the first refusal and says which half landed', async () => {
		const wrapper = await mountStep();
		// The campaign route refuses; everything after it must not be attempted.
		outcomes.set(
			JSON.stringify([
				SET_ROUTE,
				{
					messageType: 'campaign',
					strategy: 'adaptive_mix',
					providers: [
						{ providerType: 'mta', isEnabled: true },
						{ providerType: 'mandrill', isEnabled: true },
					],
					deliverabilityFallback: {
						isEnabled: true,
						relayProviderType: 'mandrill',
						isWarmupOverflowEnabled: false,
					},
				},
			]),
			undefined
		);
		await apply(wrapper);

		expect(writes).toHaveLength(2);
		expect(wrapper.find('[data-testid="migration-preset-failure"]').text()).toContain(
			'campaign route'
		);
		expect(wrapper.find('[data-testid="migration-preset-applied"]').text()).toContain(
			'transactional route applied'
		);
		expect(wrapper.emitted('applied')).toBeUndefined();
	});
});

describe('D8 — the second relay', () => {
	it('warns, by name, without blocking the write', async () => {
		const wrapper = await mountStep({
			routes: [
				{
					messageType: 'transactional',
					strategy: 'single',
					providers: [
						{ providerType: 'mta', isEnabled: true },
						{ providerType: 'ses', isEnabled: true },
					],
				},
			] satisfies MigrationRouteView[],
		});

		const warning = wrapper.find('[data-testid="migration-relay-warning"]');
		expect(warning.text()).toContain('ses');
		expect(warning.text()).toContain('holds at 0%');
		// It is a judgement, not a refusal: the route is still saveable.
		expect(
			wrapper.find('[data-testid="migration-preset-apply"]').attributes('disabled')
		).toBeUndefined();
		await apply(wrapper);
		expect(writes).toHaveLength(6);
	});

	it('says nothing when Mandrill is already the only relay', async () => {
		const wrapper = await mountStep({
			routes: [
				{
					messageType: 'campaign',
					strategy: 'adaptive_mix',
					providers: [
						{ providerType: 'mta', isEnabled: true },
						{ providerType: 'mandrill', isEnabled: true },
					],
				},
			] satisfies MigrationRouteView[],
		});
		expect(wrapper.find('[data-testid="migration-relay-warning"]').exists()).toBe(false);
		// The alignment plane's own notice is on the page regardless.
		expect(wrapper.find('[data-testid="relay-notice-stub"]').exists()).toBe(true);
	});
});
