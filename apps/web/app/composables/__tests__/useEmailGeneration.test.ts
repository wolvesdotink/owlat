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

const { useEmailGeneration } = await import('../useEmailGeneration');
const { useEmailGenerationInFlight } = await import('../useEmailGenerationInFlight');

type Outcome = { ok: true; result: unknown } | { ok: false };

let store: Map<string, Ref<unknown>>;
// The failure claim of the latest run.
let onError: ((op: OperationError) => boolean) | undefined;
let organizationId: Ref<string | null>;
let user: Ref<{ id: string } | null>;
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
	organizationId = ref('org-a');
	user = ref({ id: 'u1' });
	vi.stubGlobal('useAuth', () => ({ user, activeOrganizationId: organizationId }));
	vi.stubGlobal('useI18n', () => ({ t: (key: string) => key }));
	vi.stubGlobal('useToast', () => ({ showToast }));
	vi.stubGlobal('navigateTo', navigateTo);
	vi.stubGlobal('useState', (key: string, init: () => unknown) => {
		if (!store.has(key)) store.set(key, ref(init()));
		return store.get(key);
	});
	vi.stubGlobal('useBackendOperation', () => ({
		run: (args: unknown, runOptions: { onError?: (op: OperationError) => boolean }) => {
			calls.push(args);
			onError = runOptions.onError;
			return new Promise<Outcome>((resolve) => pending.push(resolve));
		},
	}));
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

	it('sends a retry of the same form under the same request id', async () => {
		const gen = useEmailGeneration('template');
		gen.state.value.prompt = 'October newsletter';
		const first = gen.generate();
		onError!({ category: 'network', message: 'connection lost' });
		pending[0]!({ ok: false });
		await first;
		const retry = gen.generate();
		pending[1]!({ ok: true, result: campaign });
		await retry;
		const [sent, resent] = calls as { requestId: string }[];
		expect(sent!.requestId).toMatch(/^[0-9a-f]{32}$/);
		expect(resent!.requestId).toBe(sent!.requestId);
	});

	it('sends a new request id once the form changed after a failure', async () => {
		const gen = useEmailGeneration('template');
		gen.state.value.prompt = 'October newsletter';
		const first = gen.generate();
		pending[0]!({ ok: false });
		await first;
		gen.state.value.matchStyle = false;
		void gen.generate();
		const [sent, resent] = calls as { requestId: string }[];
		expect(resent!.requestId).not.toBe(sent!.requestId);
	});

	it('sends a new request id after a success, for the same words', async () => {
		const gen = useEmailGeneration('template');
		gen.state.value.prompt = 'October newsletter';
		const first = gen.generate();
		pending[0]!({ ok: true, result: campaign });
		await first;
		gen.state.value.prompt = 'October newsletter';
		void gen.generate();
		const [sent, next] = calls as { requestId: string }[];
		expect(next!.requestId).not.toBe(sent!.requestId);
	});

	describe('per organisation', () => {
		it('keeps each organisation its own form', () => {
			const gen = useEmailGeneration('template');
			gen.state.value.prompt = 'October newsletter';
			gen.state.value.references = [{ kind: 'template', id: 'r1', name: 'Old' }];

			organizationId.value = 'org-b';
			expect(gen.state.value).toMatchObject({ prompt: '', references: [] });
			gen.state.value.prompt = 'Welcome mail';

			organizationId.value = 'org-a';
			expect(gen.state.value.prompt).toBe('October newsletter');
			expect(gen.state.value.references).toHaveLength(1);
		});

		it('does not show a run of one organisation as in flight in another', () => {
			const gen = useEmailGeneration('campaign');
			gen.state.value.prompt = 'Spring sale';
			void gen.generate();

			organizationId.value = 'org-b';

			expect(gen.isGenerating.value).toBe(false);
			expect(useEmailGenerationInFlight('campaign').value).toBe(false);
		});

		it('hands nothing over when the run lands after the organisation changed', async () => {
			const gen = useEmailGeneration('campaign');
			gen.state.value.prompt = 'Spring sale';
			const run = gen.generate();

			organizationId.value = 'org-b';
			const createdInB = vi.fn();
			gen.attach(createdInB);
			gen.state.value.prompt = 'Summer sale';
			pending[0]!({ ok: true, result: campaign });
			await run;

			expect(createdInB).not.toHaveBeenCalled();
			expect(showToast).not.toHaveBeenCalled();
			expect(gen.state.value.prompt).toBe('Summer sale');
			organizationId.value = 'org-a';
			expect(gen.state.value).toMatchObject({ prompt: '', status: 'idle' });
		});

		it('files a failure under the organisation that started the run', async () => {
			const gen = useEmailGeneration('template');
			gen.state.value.prompt = 'October newsletter';
			const run = gen.generate();

			organizationId.value = 'org-b';
			onError!({ category: 'rate_limited', message: 'busy' });
			pending[0]!({ ok: false });
			await run;

			expect(gen.state.value).toMatchObject({ status: 'idle', failure: null });
			organizationId.value = 'org-a';
			expect(gen.state.value).toMatchObject({
				prompt: 'October newsletter',
				status: 'failed',
				failure: { kind: 'rate_limited' },
			});
		});

		it('does not open the draft from a toast once the organisation changed', async () => {
			const gen = useEmailGeneration('campaign');
			gen.state.value.prompt = 'Spring sale';
			const run = gen.generate();
			pending[0]!({ ok: true, result: campaign });
			await run;
			const options = showToast.mock.calls[0]![2] as { action: { onAction: () => void } };

			organizationId.value = 'org-b';
			options.action.onAction();

			expect(navigateTo).not.toHaveBeenCalled();
		});

		it('treats another member in the same organisation as another owner', async () => {
			const gen = useEmailGeneration('campaign');
			gen.state.value.prompt = 'Spring sale';
			const run = gen.generate();

			user.value = { id: 'u2' };
			pending[0]!({ ok: true, result: campaign });
			await run;

			expect(showToast).not.toHaveBeenCalled();
			expect(gen.state.value.prompt).toBe('');
		});
	});
});
