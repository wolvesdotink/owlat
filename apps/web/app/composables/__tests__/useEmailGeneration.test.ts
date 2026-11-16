/**
 * The AI draft run behind the generate dialog: one run at a time per kind, a
 * failure keeps the prompt, a success goes to the open dialog or, with every
 * dialog closed, to a toast that opens the draft.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ref, type Ref } from 'vue';
import type { OperationError } from '@owlat/shared/operationError';

vi.mock('@owlat/api', () => {
	const anyPath: unknown = new Proxy(function () {}, {
		get: () => anyPath,
		apply: () => anyPath,
	});
	return { api: anyPath };
});

const { useEmailGeneration, useEmailGenerationInFlight } = await import('../useEmailGeneration');

type Outcome = { ok: true; result: unknown } | { ok: false };

let store: Map<string, Ref<unknown>>;
let onError: ((op: OperationError) => boolean) | undefined;
let calls: unknown[];
let pending: Array<(outcome: Outcome) => void>;
const showToast = vi.fn();
const navigateTo = vi.fn();

beforeEach(() => {
	store = new Map();
	calls = [];
	pending = [];
	showToast.mockReset();
	navigateTo.mockReset();
	vi.stubGlobal('useI18n', () => ({ t: (key: string) => key }));
	vi.stubGlobal('useToast', () => ({ showToast }));
	vi.stubGlobal('navigateTo', navigateTo);
	vi.stubGlobal('useState', (key: string, init: () => unknown) => {
		if (!store.has(key)) store.set(key, ref(init()));
		return store.get(key);
	});
	vi.stubGlobal(
		'useBackendOperation',
		(_ref: unknown, options: { onError?: (op: OperationError) => boolean }) => {
			onError = options.onError;
			return {
				run: (args: unknown) => {
					calls.push(args);
					return new Promise<Outcome>((resolve) => pending.push(resolve));
				},
			};
		}
	);
});

const campaign = { kind: 'campaign', campaignId: 'c1', templateId: 't1', droppedVariables: [] };

describe('useEmailGeneration', () => {
	it('sends one run at a time, whatever is clicked meanwhile', async () => {
		const gen = useEmailGeneration('campaign');
		gen.state.value.prompt = 'Spring sale';
		const first = gen.generate();
		void gen.generate();
		expect(calls).toHaveLength(1);
		expect(gen.isGenerating.value).toBe(true);
		// Another surface opening the same kind sees the run in progress.
		expect(useEmailGenerationInFlight('campaign').value).toBe(true);
		pending[0]!({ ok: true, result: campaign });
		await first;
		expect(gen.isGenerating.value).toBe(false);
	});

	it('does not send an empty prompt', async () => {
		const gen = useEmailGeneration('template');
		gen.state.value.prompt = '   ';
		await gen.generate();
		expect(calls).toHaveLength(0);
	});

	it('keeps the prompt and the picks after a failure, with the failure named', async () => {
		const gen = useEmailGeneration('template');
		gen.state.value.prompt = 'October newsletter';
		gen.state.value.references = [{ kind: 'template', id: 'r1', name: 'Old' }];
		const run = gen.generate();
		expect(onError!({ category: 'rate_limited', message: 'busy' })).toBe(true);
		pending[0]!({ ok: false });
		await run;
		expect(gen.state.value).toMatchObject({
			prompt: 'October newsletter',
			status: 'failed',
			failure: { kind: 'rate_limited' },
		});
		expect(gen.state.value.references).toHaveLength(1);
		gen.dismissFailure();
		expect(gen.state.value.failure).toBeNull();
	});

	it('hands the draft to the open dialog and clears the form', async () => {
		const gen = useEmailGeneration('campaign');
		const created = vi.fn();
		const detach = gen.attach(created);
		gen.state.value.prompt = 'Spring sale';
		const run = gen.generate();
		pending[0]!({ ok: true, result: campaign });
		await run;
		expect(created).toHaveBeenCalledWith(campaign);
		expect(showToast).not.toHaveBeenCalled();
		expect(gen.state.value.prompt).toBe('');
		detach();
	});

	it('offers the draft in a toast when the dialog was closed during the run', async () => {
		const gen = useEmailGeneration('campaign');
		const detach = gen.attach(vi.fn());
		gen.state.value.prompt = 'Spring sale';
		const run = gen.generate();
		detach();
		pending[0]!({ ok: true, result: campaign });
		await run;
		expect(showToast).toHaveBeenCalledTimes(1);
		const options = showToast.mock.calls[0]![2] as { action: { onAction: () => void } };
		options.action.onAction();
		expect(navigateTo).toHaveBeenCalledWith('/dashboard/campaigns/new?id=c1&step=setup');
	});

	it('passes the transactional name, slug and language along', async () => {
		const gen = useEmailGeneration('transactional');
		gen.state.value.prompt = 'Booking confirmation';
		gen.state.value.slug = 'booking';
		void gen.generate({ defaultLanguage: 'de' });
		expect(calls[0]).toMatchObject({
			kind: 'transactional',
			slug: 'booking',
			defaultLanguage: 'de',
		});
		expect(calls[0]).not.toHaveProperty('name');
	});
});
