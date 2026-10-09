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
import { draftHashOf } from '@owlat/shared/threadBriefRules';
import type { BriefItemView } from '../../../../api/convex/mail/interpret/briefShape';
import { PLAN_COVERAGE_DEBOUNCE_MS, useResponsePlan, type PlanDraftRef } from '../useResponsePlan';

vi.mock('@owlat/api', () => ({
	api: {
		mail: {
			interpret: {
				responsePlan: {
					get: 'plan.get',
					setStances: 'plan.setStances',
					adoptArrivalPlan: 'plan.adopt',
				},
				coverage: { check: 'coverage.check' },
			},
		},
	},
}));

const stored = ref<unknown>(undefined);
const queryArgs: unknown[] = [];
const action = vi.fn();
const mutation = vi.fn(async () => null);

const CHECKED_ITEMS = [
	{ itemId: 'contract', revision: 1 },
	{ itemId: 'quote', revision: 1 },
];

/** The stored plan as `responsePlan.get` returns it, before any check. */
function storedView(over: Record<string, unknown> = {}) {
	return {
		stances: [],
		coverage: [],
		fileClaims: [],
		newPromises: [],
		threadRevision: 4,
		planRevision: 0,
		verdict: 'pending',
		isStale: false,
		...over,
	};
}

const showToast = vi.fn();

beforeEach(() => {
	stored.value = storedView();
	showToast.mockClear();
	vi.stubGlobal('useToast', () => ({ showToast }));
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
		stored.value = storedView({
			stances: [
				{ itemId: 'contract', stance: 'clarify', source: 'default' },
				{ itemId: 'quote', stance: 'answer', source: 'default' },
			],
		});
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

async function result(text: string, over: Record<string, unknown> = {}) {
	return {
		coverage: [
			{ itemId: 'contract', verdict: 'addressed', spans: [] },
			{ itemId: 'quote', verdict: 'partial', spans: [] },
		],
		fileClaims: [{ text: 'I’ve attached the contract.', spans: [], isMatched: false }],
		newPromises: [{ text: 'I’ll send the logo by Friday', spans: [] }],
		isIncomplete: false,
		planRevision: 0,
		draftHash: await draftHashOf(text),
		threadRevision: 4,
		itemRevisions: [
			{ itemId: 'contract', revision: 1 },
			{ itemId: 'quote', revision: 1 },
		],
		isChecked: true,
		isStored: true,
		...over,
	};
}

describe('coverage', () => {
	it('checks once typing pauses, with the text, after the choices are written', async () => {
		vi.useFakeTimers();
		const text = ref('');
		const { plan } = host({ text });
		const written = 'Hi Jonas, I’ve attached the contract.';
		action.mockResolvedValueOnce(await result(written));
		text.value = written;
		await nextTick();
		vi.advanceTimersByTime(PLAN_COVERAGE_DEBOUNCE_MS - 10);
		expect(action).not.toHaveBeenCalled();
		vi.advanceTimersByTime(20);
		await vi.runAllTimersAsync();
		await flushPromises();
		expect(action).toHaveBeenCalledWith('coverage.check', {
			threadRef: { kind: 'mail', id: 't1' },
			draftRef: { kind: 'mailDraft', id: 'd1' },
			draftText: written,
		});
		vi.useRealTimers();
		await vi.waitFor(() => expect(plan.addressed.value).toEqual(['contract']));
		expect(plan.missingFiles.value).toEqual(['I’ve attached the contract.']);
		expect([...plan.view.fileMissing.value]).toEqual(['contract']);
		expect(plan.statusNote.value).toBe(
			'1 of 2 addressed · 1 needs a file · new promise noted: “I’ll send the logo by Friday”'
		);
	});

	it('F10: shows chips only for the text on screen; an edit makes it "checking" at once', async () => {
		const text = ref('First version.');
		const { plan } = host({ text });
		action.mockResolvedValueOnce(await result('First version.'));
		await plan.checkCoverage();
		await vi.waitFor(() => expect(plan.addressed.value).toEqual(['contract']));
		text.value = 'First version, edited.';
		await flushPromises();
		expect(plan.addressed.value).toEqual([]);
		expect(plan.missingFiles.value).toEqual([]);
		expect(plan.statusNote.value).toBe('Checking the draft…');
	});

	it('F10: a result for another plan revision is not shown', async () => {
		const text = ref('Hello.');
		const { plan } = host({ text });
		stored.value = storedView({ planRevision: 3 });
		action.mockResolvedValueOnce(await result('Hello.', { planRevision: 2 }));
		await plan.checkCoverage();
		await flushPromises();
		expect(plan.addressed.value).toEqual([]);
	});

	it('lets the newest check win, and never checks an empty draft', async () => {
		const text = ref('first');
		const { plan } = host({ text });
		let resolveOld!: (value: unknown) => void;
		action.mockImplementationOnce(() => new Promise((r) => (resolveOld = r)));
		const older = plan.checkCoverage();
		await flushPromises();
		text.value = 'second';
		action.mockResolvedValueOnce(
			await result('second', { coverage: [], fileClaims: [], newPromises: [] })
		);
		await plan.checkCoverage();
		resolveOld(await result('first'));
		await older;
		await flushPromises();
		expect(plan.addressed.value).toEqual([]);

		text.value = '  ';
		await plan.checkCoverage();
		expect(action).toHaveBeenCalledTimes(2);
		expect(plan.statusNote.value).toBeUndefined();
	});

	it('shows the stored coverage until this page checks, when it is current', async () => {
		const text = ref('The quote is approved.');
		stored.value = storedView({
			coverage: [{ itemId: 'quote', verdict: 'addressed', spans: [] }],
			checkedPlanRevision: 0,
			checkedThreadRevision: 4,
			checkedItemRevisions: CHECKED_ITEMS,
			draftHash: await draftHashOf('The quote is approved.'),
			verdict: 'gaps',
		});
		const { plan } = host({ text });
		await vi.waitFor(() => expect(plan.addressed.value).toEqual(['quote']));
		expect(plan.statusNote.value).toBe('1 of 2 addressed');
		stored.value = { ...(stored.value as object), isStale: true, verdict: 'stale' };
		expect(plan.addressed.value).toEqual([]);
	});

	it('does not count a skipped item', async () => {
		const { plan } = host({ text: ref('Hi') });
		plan.setSelected(['contract']);
		stored.value = storedView({
			stances: [{ itemId: 'quote', stance: 'skip', source: 'owner' }],
		});
		action.mockResolvedValueOnce(await result('Hi'));
		await plan.checkCoverage();
		await vi.waitFor(() => expect(plan.statusNote.value).toMatch(/^1 of 1 addressed/));
	});

	it('F12: checks file claims and promises with nothing planned', async () => {
		const { plan, items } = host({ text: ref('I’ve attached it.') });
		items.value = [];
		action.mockResolvedValueOnce(
			await result('I’ve attached it.', { coverage: [], itemRevisions: [] })
		);
		await plan.checkCoverage();
		await flushPromises();
		expect(action).toHaveBeenCalledTimes(1);
		await vi.waitFor(() =>
			expect(plan.missingFiles.value).toEqual(['I’ve attached the contract.'])
		);
	});

	it('F11: flush writes the choices to a draft created just now, before the AI drafts', async () => {
		const draftRef = ref<PlanDraftRef | null>(null);
		const { plan } = host({ draftRef });
		plan.setStance('quote', 'accept');
		await flushPromises();
		expect(mutation).not.toHaveBeenCalled();
		await plan.flush({ kind: 'mailDraft', id: 'd7' as never });
		expect(mutation).toHaveBeenCalledWith(
			'plan.setStances',
			expect.objectContaining({ draftRef: { kind: 'mailDraft', id: 'd7' } })
		);
	});
});

describe('review round 2', () => {
	it('F3: an item change hides the local result and schedules a fresh check', async () => {
		vi.useFakeTimers();
		const text = ref('Hello.');
		const { plan, items } = host({ text });
		action.mockResolvedValue(await result('Hello.'));
		await plan.checkCoverage();
		vi.useRealTimers();
		await vi.waitFor(() => expect(plan.addressed.value).toEqual(['contract']));
		vi.useFakeTimers();
		items.value = [{ ...contract, revision: 2 }, quote];
		await nextTick();
		expect(plan.addressed.value).toEqual([]);
		vi.advanceTimersByTime(PLAN_COVERAGE_DEBOUNCE_MS + 10);
		await vi.runAllTimersAsync();
		expect(action).toHaveBeenCalledTimes(2);
	});

	it('F4: a failed stance write rejects flush, is said, and no check runs', async () => {
		const text = ref('Hello.');
		const { plan } = host({ text });
		mutation.mockRejectedValue(new Error('offline'));
		plan.setStance('quote', 'decline');
		await expect(plan.flush()).rejects.toThrow();
		await flushPromises();
		expect(showToast).toHaveBeenCalledWith(
			'Your choices for the reply could not be saved. Try again.',
			'error'
		);
		await plan.checkCoverage();
		expect(action).not.toHaveBeenCalled();
		mutation.mockResolvedValue(null);
	});

	it('F4: coverage stays hidden until the stored plan has the choices on screen', async () => {
		const text = ref('Hello.');
		const { plan } = host({ text });
		action.mockResolvedValueOnce(await result('Hello.'));
		await plan.checkCoverage();
		await vi.waitFor(() => expect(plan.addressed.value).toEqual(['contract']));
		plan.setStance('quote', 'decline');
		await flushPromises();
		// Written, but the subscription still shows the old stance.
		expect(plan.addressed.value).toEqual([]);
		stored.value = storedView({
			stances: [{ itemId: 'quote', stance: 'decline', source: 'owner' }],
		});
		await nextTick();
		await vi.waitFor(() => expect(plan.addressed.value).toEqual(['contract']));
	});
});

describe('review round 3', () => {
	it('F1: closing an item hides the stored coverage and checks again', async () => {
		vi.useFakeTimers();
		const text = ref('The quote is approved.');
		stored.value = storedView({
			coverage: [{ itemId: 'quote', verdict: 'addressed', spans: [] }],
			checkedPlanRevision: 0,
			checkedThreadRevision: 4,
			checkedItemRevisions: CHECKED_ITEMS,
			draftHash: await draftHashOf('The quote is approved.'),
			verdict: 'gaps',
		});
		const { plan, items } = host({ text });
		vi.useRealTimers();
		await vi.waitFor(() => expect(plan.addressed.value).toEqual(['quote']));
		vi.useFakeTimers();
		action.mockResolvedValue(null);
		// "Mark done" on the contract: the thread revision stays, the item leaves.
		items.value = [quote];
		await nextTick();
		expect(plan.addressed.value).toEqual([]);
		vi.advanceTimersByTime(PLAN_COVERAGE_DEBOUNCE_MS + 10);
		await vi.runAllTimersAsync();
		expect(action).toHaveBeenCalledTimes(1);
	});

	it('F3: an item change during the first request is followed by a fresh check (delayed response)', async () => {
		vi.useFakeTimers();
		const text = ref('Hello.');
		const { plan, items } = host({ text });
		let respond!: (value: unknown) => void;
		action.mockImplementationOnce(() => new Promise((r) => (respond = r)));
		const first = plan.checkCoverage();
		await vi.advanceTimersByTimeAsync(0);
		expect(action).toHaveBeenCalledTimes(1);
		items.value = [{ ...contract, revision: 2 }, quote];
		await nextTick();
		// The delayed response was computed for the old revisions.
		respond(await result('Hello.'));
		await first;
		expect(plan.addressed.value).toEqual([]);
		action.mockResolvedValueOnce(
			await result('Hello.', {
				itemRevisions: [
					{ itemId: 'contract', revision: 2 },
					{ itemId: 'quote', revision: 1 },
				],
			})
		);
		await vi.advanceTimersByTimeAsync(PLAN_COVERAGE_DEBOUNCE_MS + 10);
		expect(action).toHaveBeenCalledTimes(2);
		vi.useRealTimers();
		await vi.waitFor(() => expect(plan.addressed.value).toEqual(['contract']));
	});
});
