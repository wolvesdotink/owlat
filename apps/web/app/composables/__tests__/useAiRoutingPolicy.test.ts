/**
 * The routing policy panel's state: the form follows the stored policy while
 * it is clean and keeps the admin's edits while it is not, a save sends only
 * the changed fields against the loaded version, and a version conflict is
 * shown inline (no toast) and reloads the newer policy.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { nextTick, ref, type Ref } from 'vue';
import { resolveRoutingPolicy, type ResolvedRoutingPolicy } from '@owlat/shared/aiRouting';
import type { OperationError } from '@owlat/shared/operationError';
import { createTestI18n } from '~/__tests__/i18n';

vi.mock('@owlat/api', () => ({
	api: { aiRouting: { policy: { get: 'policy.get', update: 'policy.update' } } },
}));

const { useAiRoutingPolicy } = await import('../useAiRoutingPolicy');

let data: Ref<Record<string, unknown> | null>;
let updateCalls: Record<string, unknown>[];
let nextUpdate: (args: Record<string, unknown>) => Promise<unknown>;
let onError: ((op: OperationError) => boolean) | undefined;
const showToast = vi.fn();

function getResult(policy: ResolvedRoutingPolicy, overrides: Record<string, unknown> = {}) {
	return {
		policy,
		defaults: resolveRoutingPolicy(null),
		isStored: policy.policyVersion > 0,
		dailyCeilingUsd: 25,
		monthlyCeilingUsd: 400,
		...overrides,
	};
}

beforeEach(() => {
	const i18n = createTestI18n();
	vi.stubGlobal('useI18n', () => i18n.global);
	vi.stubGlobal('useToast', () => ({ showToast }));
	showToast.mockReset();
	data = ref(getResult(resolveRoutingPolicy(null)));
	updateCalls = [];
	nextUpdate = async (args) => ({
		ok: true,
		result: resolveRoutingPolicy({ ...args, policyVersion: 1, updatedAt: 1 }),
	});
	vi.stubGlobal('useOrganizationQuery', () => ({
		data,
		isLoading: ref(false),
		error: ref(null),
		refetch: vi.fn(),
	}));
	vi.stubGlobal(
		'useBackendOperation',
		(_ref: unknown, options: { onError?: (op: OperationError) => boolean }) => {
			onError = options.onError;
			return {
				run: vi.fn(async (args: Record<string, unknown>) => {
					updateCalls.push(args);
					return nextUpdate(args);
				}),
				isLoading: ref(false),
			};
		}
	);
});

describe('useAiRoutingPolicy', () => {
	it('opens on the defaults, clean, with nothing to save', async () => {
		const state = useAiRoutingPolicy();
		expect(state.form.switches.triageBundle).toBe('off');
		expect(state.isDirty.value).toBe(false);
		expect(await state.save()).toBe(true);
		expect(updateCalls).toEqual([]);
	});

	it('saves only what changed and takes the returned policy', async () => {
		const state = useAiRoutingPolicy();
		state.form.switches.attachmentGates = 'enforce';
		state.form.triagePercent = '15';
		expect(state.isDirty.value).toBe(true);
		expect(await state.save()).toBe(true);
		expect(updateCalls).toEqual([
			{ expectedPolicyVersion: 0, attachmentGates: 'enforce', triageAllowanceFraction: 0.15 },
		]);
		expect(state.isDirty.value).toBe(false);
		expect(state.form.switches.attachmentGates).toBe('enforce');
		expect(showToast).toHaveBeenCalledWith('AI routing saved.');
	});

	it('refuses to save a form with a problem, and sends nothing', async () => {
		const state = useAiRoutingPolicy();
		state.form.shadowMessagePercent = '50';
		expect(state.hasProblems.value).toBe(true);
		expect(await state.save()).toBe(false);
		expect(updateCalls).toEqual([]);
	});

	it('states the shadow allowance as the form stands', () => {
		const state = useAiRoutingPolicy();
		expect(state.isShadowing.value).toBe(false);
		expect(state.shadowAllowance.value).toBe(0);
		state.form.switches.triageBundle = 'shadow';
		expect(state.isShadowing.value).toBe(true);
		expect(state.shadowAllowance.value).toBeCloseTo(1.25);
	});

	it('follows the stored policy while clean, and keeps unsaved edits while not', async () => {
		const state = useAiRoutingPolicy();
		data.value = getResult(resolveRoutingPolicy({ policyVersion: 1, batchApi: 'enforce' }));
		await nextTick();
		expect(state.form.switches.batchApi).toBe('enforce');
		state.form.knowledgeEntryCap = '4';
		data.value = getResult(resolveRoutingPolicy({ policyVersion: 2 }));
		await nextTick();
		expect(state.form.knowledgeEntryCap).toBe('4');
		expect(state.form.switches.batchApi).toBe('enforce');
	});

	it('shows a version conflict inline and reloads the newer policy', async () => {
		const state = useAiRoutingPolicy();
		state.form.switches.earlyRuleArchive = 'enforce';
		data.value = getResult(resolveRoutingPolicy({ policyVersion: 4, batchApi: 'enforce' }));
		nextUpdate = async () => {
			const claimed = onError?.({ category: 'conflict', message: 'changed' });
			expect(claimed).toBe(true);
			return { ok: false };
		};
		expect(await state.save()).toBe(false);
		expect(state.isConflict.value).toBe(true);
		expect(state.isDirty.value).toBe(false);
		expect(state.form.switches.earlyRuleArchive).toBe('off');
		expect(state.form.switches.batchApi).toBe('enforce');
		// The next edit clears the notice.
		state.form.switches.earlyRuleArchive = 'enforce';
		expect(state.isConflict.value).toBe(false);
	});

	it('leaves other failures to the operation layer', () => {
		useAiRoutingPolicy();
		expect(onError?.({ category: 'invalid_input', message: 'bad' })).toBe(false);
	});

	it('discards unsaved edits back to the stored policy', () => {
		const state = useAiRoutingPolicy();
		state.form.switches.cheapFirstWriter = 'reviewed';
		state.discard();
		expect(state.form.switches.cheapFirstWriter).toBe('off');
		expect(state.isDirty.value).toBe(false);
	});
});
