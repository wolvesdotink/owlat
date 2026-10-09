// @vitest-environment happy-dom
/**
 * Answer mode's response plan (composables/useResponsePlan, SPEC §6):
 *   - stances come from the server's plan, with the person's choices on top;
 *     unselecting an item skips it, reselecting answers it again;
 *   - a choice is written onto the draft's plan once the draft exists, the
 *     ones made before that with the first save;
 *   - the coverage check waits for typing to pause, sends the draft's text and
 *     the current stances, and a newer check wins over an older one in flight;
 *     an empty draft is not checked;
 *   - the footer line says what is addressed, what needs a file and the
 *     promise the draft makes, and nothing before something is written;
 *   - "File missing" goes on a file item the draft addresses while it claims
 *     an attachment that is not there.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { defineComponent, h, nextTick, ref, type Ref } from 'vue';
import { flushPromises, mount } from '@vue/test-utils';
import { createTestI18n, i18nStubs } from '~/__tests__/i18n';
import { item } from '~/utils/__tests__/threadBriefFixtures';
import type { BriefItemView } from '../../../../api/convex/mail/interpret/briefShape';
import { PLAN_COVERAGE_DEBOUNCE_MS, useResponsePlan, type PlanDraftRef } from '../useResponsePlan';

vi.mock('@owlat/api', () => ({
	api: {
		mail: {
			interpret: {
				responsePlan: { get: 'plan.get', setStances: 'plan.setStances' },
				coverage: { check: 'coverage.check' },
			},
		},
	},
}));

const stored = ref<unknown>(undefined);
const queryArgs: unknown[] = [];
const action = vi.fn();
const mutation = vi.fn(async () => null);

beforeEach(() => {
	stored.value = undefined;
	queryArgs.length = 0;
	action.mockReset();
	mutation.mockClear();
	vi.stubGlobal('useI18n', i18nStubs.useI18n);
	vi.stubGlobal('useFeatureFlag', () => ({ isEnabled: () => true }));
	vi.stubGlobal('useConvexQuery', (_fn: string, args: () => unknown) => {
		queryArgs.push(args());
		return { data: stored };
	});
	vi.stubGlobal('requireConvex', () => ({ action, mutation }));
});
afterEach(() => vi.useRealTimers());

const contract = item({ id: 'contract', text: 'Send the signed contract', facets: ['file'] });
const quote = item({
	id: 'quote',
	text: 'Approve the quote',
	intent: 'decision',
	facets: ['payment'],
});

function host(opts: { draftRef?: Ref<PlanDraftRef | null>; text?: Ref<string> } = {}) {
	const draftRef =
		opts.draftRef ?? ref<PlanDraftRef | null>({ kind: 'mailDraft', id: 'd1' as never });
	const text = opts.text ?? ref('');
	const items = ref<BriefItemView[]>([contract, quote]);
	let plan!: ReturnType<typeof useResponsePlan>;
	mount(
		defineComponent({
			setup() {
				plan = useResponsePlan({
					threadRef: () => ({ kind: 'mail', id: 't1' as never }),
					draftRef: () => draftRef.value,
					draftText: () => text.value,
					items: () => items.value,
				});
				return () => h('div');
			},
		}),
		{ global: { plugins: [createTestI18n()] } }
	);
	return { plan, draftRef, text, items };
}

describe('stances', () => {
	it('reads the stored plan for this thread and draft, with the person’s choices on top', async () => {
		stored.value = {
			stances: [
				{ itemId: 'contract', stance: 'clarify', source: 'default' },
				{ itemId: 'quote', stance: 'answer', source: 'default' },
			],
			coverage: [],
			fileClaims: [],
			newPromises: [],
			verdict: 'pending',
			isStale: false,
		};
		const { plan } = host();
		expect(queryArgs[0]).toEqual({
			threadRef: { kind: 'mail', id: 't1' },
			draftRef: { kind: 'mailDraft', id: 'd1' },
		});
		expect(plan.view.stanceOf('contract')).toBe('clarify');
		plan.setStance('quote', 'accept');
		expect(plan.view.stanceOf('quote')).toBe('accept');
		await flushPromises();
		expect(mutation).toHaveBeenCalledWith('plan.setStances', {
			threadRef: { kind: 'mail', id: 't1' },
			draftRef: { kind: 'mailDraft', id: 'd1' },
			stances: [{ itemId: 'quote', stance: 'accept' }],
		});
	});

	it('skips an unselected item and answers a reselected one', () => {
		const { plan } = host();
		expect(plan.selected.value).toEqual(['contract', 'quote']);
		plan.setSelected(['quote']);
		expect(plan.view.stanceOf('contract')).toBe('skip');
		expect(plan.selected.value).toEqual(['quote']);
		plan.setSelected(['quote', 'contract']);
		expect(plan.view.stanceOf('contract')).toBe('answer');
	});

	it('keeps choices made before the draft exists and writes them with the first save', async () => {
		const draftRef = ref<PlanDraftRef | null>(null);
		const { plan } = host({ draftRef });
		plan.setStance('quote', 'decline');
		await flushPromises();
		expect(mutation).not.toHaveBeenCalled();
		draftRef.value = { kind: 'mailDraft', id: 'd9' as never };
		await nextTick();
		await flushPromises();
		expect(mutation).toHaveBeenCalledWith(
			'plan.setStances',
			expect.objectContaining({
				draftRef: { kind: 'mailDraft', id: 'd9' },
				stances: [{ itemId: 'quote', stance: 'decline' }],
			})
		);
	});
});

const RESULT = {
	coverage: [
		{ itemId: 'contract', verdict: 'addressed', spans: [] },
		{ itemId: 'quote', verdict: 'partial', spans: [] },
	],
	fileClaims: [{ text: 'I’ve attached the contract.', spans: [], isMatched: false }],
	newPromises: [{ text: 'I’ll send the logo by Friday', spans: [] }],
	draftHash: 'h1',
	isChecked: true,
};

describe('coverage', () => {
	it('checks once typing pauses, with the text and the stances', async () => {
		vi.useFakeTimers();
		const text = ref('');
		const { plan } = host({ text });
		action.mockResolvedValueOnce(RESULT);
		text.value = 'Hi Jonas, I’ve attached the contract.';
		await nextTick();
		vi.advanceTimersByTime(PLAN_COVERAGE_DEBOUNCE_MS - 10);
		expect(action).not.toHaveBeenCalled();
		vi.advanceTimersByTime(20);
		await flushPromises();
		expect(action).toHaveBeenCalledWith('coverage.check', {
			threadRef: { kind: 'mail', id: 't1' },
			draftRef: { kind: 'mailDraft', id: 'd1' },
			draftText: 'Hi Jonas, I’ve attached the contract.',
			stances: [
				{ itemId: 'contract', stance: 'answer' },
				{ itemId: 'quote', stance: 'answer' },
			],
		});
		expect(plan.addressed.value).toEqual(['contract']);
		expect(plan.missingFiles.value).toEqual(['I’ve attached the contract.']);
		expect([...plan.view.fileMissing.value]).toEqual(['contract']);
		expect(plan.statusNote.value).toBe(
			'1 of 2 addressed · 1 needs a file · new promise noted: “I’ll send the logo by Friday”'
		);
	});

	it('lets the newest check win, and never checks an empty draft', async () => {
		const text = ref('first');
		const { plan } = host({ text });
		let resolveOld!: (value: unknown) => void;
		action.mockImplementationOnce(() => new Promise((r) => (resolveOld = r)));
		const older = plan.checkCoverage();
		text.value = 'second';
		action.mockResolvedValueOnce({ ...RESULT, coverage: [], fileClaims: [], newPromises: [] });
		await plan.checkCoverage();
		resolveOld(RESULT);
		await older;
		expect(plan.addressed.value).toEqual([]);

		text.value = '  ';
		await plan.checkCoverage();
		expect(action).toHaveBeenCalledTimes(2);
		expect(plan.statusNote.value).toBeUndefined();
	});

	it('shows the stored coverage until this page checks, when it is current', () => {
		stored.value = {
			stances: [],
			coverage: [{ itemId: 'quote', verdict: 'addressed', spans: [] }],
			fileClaims: [],
			newPromises: [],
			draftHash: 'h0',
			verdict: 'gaps',
			isStale: false,
		};
		const { plan } = host({ text: ref('The quote is approved.') });
		expect(plan.addressed.value).toEqual(['quote']);
		expect(plan.statusNote.value).toBe('1 of 2 addressed');
		stored.value = { ...(stored.value as object), isStale: true, verdict: 'stale' };
		expect(plan.addressed.value).toEqual([]);
	});

	it('does not count a skipped item', async () => {
		const { plan } = host({ text: ref('Hi') });
		plan.setSelected(['contract']);
		action.mockResolvedValueOnce(RESULT);
		await plan.checkCoverage();
		expect(plan.statusNote.value).toMatch(/^1 of 1 addressed/);
	});
});
