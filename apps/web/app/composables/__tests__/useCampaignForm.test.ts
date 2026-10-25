/**
 * The campaign edit page runs the wizard's recipients and sender controls,
 * and a draft campaign saves itself through its session.
 *
 * `useCampaignForm` used to keep its own copy of the audience state and a
 * free-text From address that it checked only for shape, so an address off the
 * curated list got as far as the save and was refused there. The sender
 * picker's `validate()` now guards the save, and the picker's own settling of
 * the loaded From must not look like an unsaved edit.
 *
 * Autosave: a save carries only the sections that changed and covers only
 * those; an unfinished section is kept on the device; the schedule is kept
 * nowhere but the form and guarded until Schedule or Discard. Leaving goes
 * through the real unsaved-changes guard.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { nextTick, reactive, ref, type Ref } from 'vue';
import type { Id } from '@owlat/api/dataModel';
import { createTestI18n } from '~/__tests__/i18n';
import { until } from '~/__tests__/until';
import { withSetup } from '~/__tests__/withSetup';
import type { SenderPickerHandle } from '~/utils/campaignSenderPicker';
import {
	createEditorDraftStore,
	editorDraftKey,
	editorDraftScope,
	type EditorDraftStore,
} from '~/utils/editorDraftStore';
import { createNoopDriver } from '~/utils/postboxOfflineKvDriver';

// A test that needs device copies sets `draftStore`; the rest have none.
let draftStore: EditorDraftStore | null = null;
vi.mock('~/utils/editorDraftStore', async (importOriginal) => {
	const actual: { getEditorDraftStore: () => EditorDraftStore } = await importOriginal();
	return { ...actual, getEditorDraftStore: () => draftStore ?? actual.getEditorDraftStore() };
});
const routes = vi.hoisted(() => ({
	guards: [] as ((to: unknown, from: unknown, next: (v?: unknown) => void) => unknown)[],
	push: vi.fn(),
}));
vi.mock('vue-router', () => ({
	onBeforeRouteLeave: (guard: (typeof routes.guards)[number]) => routes.guards.push(guard),
	useRouter: () => ({ push: routes.push }),
}));

const i18n = createTestI18n();
const t = (key: string) => i18n.global.t(key);

let campaign: Ref<Record<string, unknown> | undefined>;
let runs: { label: string; args: unknown }[];
/** Runs with this label fail. */
let failLabel: string | null;
/** The next run's outcome, for the background-save cases. */
let failNext: boolean;
/** Runs with this label wait for the test. */
let holdLabel: string | null;
let held: (() => void)[];
let showToast: ReturnType<typeof vi.fn>;
/** What a run that lands reports (`saveDraft`: the campaign's `updatedAt`). */
let landed: unknown;

function paginated(rows: unknown[] = []) {
	return {
		results: ref(rows),
		status: ref('Exhausted'),
		isLoading: ref(false),
		error: ref(null),
		refetch: vi.fn(),
		loadMore: vi.fn(),
	};
}

function memoryStore() {
	const data = new Map<string, unknown>();
	return {
		data,
		store: createEditorDraftStore({
			...createNoopDriver(),
			persistent: true,
			get: async <T>(key: string) => data.get(key) as T,
			set: async (key, value) => {
				data.set(key, JSON.parse(JSON.stringify(value)));
			},
			delete: async (key) => {
				data.delete(key);
			},
			keys: async () => [...data.keys()],
			deleteIf: async (key, predicate) => {
				if (!predicate(data.get(key))) return false;
				data.delete(key);
				return true;
			},
		}),
	};
}

beforeEach(() => {
	runs = [];
	// `saveDraft`'s report; nobody else wrote in between.
	landed = { campaignId: 'cmp_1', updatedAt: 150, previousUpdatedAt: 100 };
	draftStore = null;
	failNext = false;
	failLabel = null;
	holdLabel = null;
	held = reactive([]);
	showToast = vi.fn();
	routes.guards = [];
	routes.push.mockClear();
	campaign = ref(undefined);
	vi.stubGlobal('useI18n', () => i18n.global);
	vi.stubGlobal('useRouter', () => ({ push: routes.push }));
	vi.stubGlobal('useToast', () => ({ showToast }));
	vi.stubGlobal('useAuth', () => ({
		user: ref({ id: 'user_1' }),
		activeOrganizationId: ref('org_1'),
	}));
	vi.stubGlobal('useCampaignUndoSend', () => ({ arm: vi.fn() }));
	vi.stubGlobal('useFeatureFlag', () => ({ flags: ref({}) }));
	vi.stubGlobal('useConvexQuery', () => ({
		data: campaign,
		isLoading: ref(false),
		error: ref(null),
	}));
	vi.stubGlobal('useTopicsList', () => paginated([{ _id: 'tp_1', name: 'Newsletter' }]));
	vi.stubGlobal('useOrganizationPaginatedQuery', () => paginated());
	vi.stubGlobal('useOrganizationQuery', () => ({ data: ref(undefined) }));
	vi.stubGlobal('useConvex', () => null);
	vi.stubGlobal(
		'useBackendOperation',
		(
			_reference: unknown,
			options: {
				label: string | (() => string);
				onError?: (op: { category: string; message: string }) => boolean;
			}
		) => ({
			run: async (args: unknown) => {
				const label = typeof options.label === 'function' ? options.label() : options.label;
				runs.push({ label, args });
				if (label === holdLabel) await new Promise<void>((resolve) => held.push(resolve));
				if (failNext || label === failLabel) {
					failNext = false;
					options.onError?.({ category: 'invalid_input', message: 'Name is too long' });
					return { ok: false };
				}
				return { ok: true, result: landed };
			},
		})
	);
});

afterEach(() => {
	vi.unstubAllGlobals();
});

const { useCampaignForm } = await import('../useCampaignForm');
const { useCampaignABTest } = await import('../useCampaignABTest');
const { useUnsavedChanges } = await import('../useUnsavedChanges');

const DRAFT = {
	_id: 'cmp_1',
	status: 'draft',
	name: 'September newsletter',
	fromName: 'Owlat news',
	fromEmail: 'news@owlat.example',
	replyTo: '',
	audience: { kind: 'segment', segmentId: 'sg_1' },
	emailTemplateId: 'tpl_1',
	subject: 'What is new',
	updatedAt: 100,
};

async function setup(senderProblem: string | null = null, row: Record<string, unknown> = DRAFT) {
	vi.stubGlobal('useUnsavedChanges', useUnsavedChanges);
	const validate = vi.fn(() => senderProblem);
	const picker = ref<SenderPickerHandle | null>({ validate, isReady: senderProblem === null });
	const page = withSetup(() => {
		const abTest = useCampaignABTest();
		return { abTest, form: useCampaignForm(ref('cmp_1' as Id<'campaigns'>), abTest, picker) };
	});
	campaign.value = { ...row };
	await nextTick();
	await nextTick();
	await nextTick();
	return { ...page.result, validate, unmount: page.unmount };
}

/** Runs the page's leave guard; resolves whether it let the page go. */
async function leave(to = '/dashboard/campaigns') {
	let answer: unknown = 'none';
	await routes.guards.at(-1)?.({ fullPath: to }, {}, (value?: unknown) => {
		answer = value;
	});
	return answer !== false;
}

const saves = () => runs.filter((run) => run.label === 'Save campaign draft');

type Form = Awaited<ReturnType<typeof setup>>['form'];
/** The session's milestones a test waits for. */
const saveLanded = (form: Form) =>
	until(() => {
		const s = form.drafts.autosave.state.value;
		return s.flight === null && s.savedAt !== null;
	});
const copyCommitted = (form: Form) =>
	until(() => {
		const s = form.drafts.autosave.state.value;
		return s.writes.length === 0 && s.onDisk !== null;
	});

describe('useCampaignForm on the wizard controls', () => {
	it('hydrates the recipients from the saved campaign', async () => {
		const { form } = await setup();
		expect(form.campaignAudience.audienceType.value).toBe('segment');
		expect(form.audience.value).toEqual({ kind: 'segment', segmentId: 'sg_1' });
		expect(form.drafts.autosave.dirty.value).toBe(false);
	});

	it('refuses the save when the sender picker reports a problem', async () => {
		const { form, validate } = await setup('Choose who this campaign comes from.');
		expect(await form.handleSave()).toBe(false);
		expect(validate).toHaveBeenCalled();
		expect(runs).toEqual([]);
	});

	it('saves the picked sender without a free-text address check of its own', async () => {
		const { form } = await setup();
		form.fromEmail.value = 'team@owlat.example';
		await nextTick();
		expect(await form.handleSave()).toBe(true);
		expect(form.errors.value).toEqual({});
		// What the server already holds needs no write; the changed sender goes.
		expect(saves().map((run) => run.args)).toEqual([
			{ campaignId: 'cmp_1', fromEmail: 'team@owlat.example' },
		]);
	});

	it('keeps a clean form clean when the picker settles the loaded sender', async () => {
		const { form } = await setup();
		// The picker writes the curated row's current name, then says it did.
		form.fromName.value = 'Owlat';
		form.onSenderPreselected();
		await nextTick();
		await nextTick();
		expect(form.drafts.autosave.dirty.value).toBe(false);

		// A user edit afterwards is pending.
		form.fromEmail.value = 'hello@owlat.example';
		await nextTick();
		expect(form.drafts.autosave.dirty.value).toBe(true);
	});

	it('leaves an already edited form dirty when the picker settles', async () => {
		const { form } = await setup();
		form.replyTo.value = 'support@owlat.example';
		await nextTick();
		form.fromName.value = 'Owlat';
		form.onSenderPreselected();
		await nextTick();
		await nextTick();
		expect(form.drafts.autosave.dirty.value).toBe(true);
	});
});

describe('useCampaignForm autosave', () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});
	afterEach(() => {
		vi.useRealTimers();
	});

	it('saves only the section that changed, without a Save button', async () => {
		const { form } = await setup();
		form.replyTo.value = 'support@owlat.example';
		await nextTick();
		await vi.advanceTimersByTimeAsync(1500);

		expect(saves().map((run) => run.args)).toEqual([
			{ campaignId: 'cmp_1', replyTo: 'support@owlat.example' },
		]);
		expect(form.drafts.autosave.status.value).toBe('saved');
		expect(form.drafts.autosave.atRisk.value).toBe(false);
	});

	it('saves a partial draft that would not pass the send checks', async () => {
		const { form, validate } = await setup('Choose who this campaign comes from.');
		form.campaignName.value = '';
		form.campaignSubject.value = '';
		await nextTick();
		await vi.advanceTimersByTimeAsync(1500);

		expect(validate).not.toHaveBeenCalled();
		expect(saves().map((run) => run.args)).toEqual([
			{ campaignId: 'cmp_1', name: '', content: { emailTemplateId: 'tpl_1', subject: '' } },
		]);
	});

	it('leaves an A/B test out until it is complete, and keeps it at risk meanwhile', async () => {
		const { form, abTest } = await setup();
		abTest.abTestEnabled.value = true;
		form.archiveEnabled.value = true;
		await nextTick();
		await vi.advanceTimersByTimeAsync(1500);
		expect(saves().at(-1)?.args).toEqual({ campaignId: 'cmp_1', archiveEnabled: true });
		// The archive setting landed; the unfinished test is kept nowhere (no IndexedDB here).
		expect(form.drafts.autosave.atRisk.value).toBe(true);
		expect(form.drafts.autosave.status.value).toBe('unkept');

		abTest.abVariantBSubject.value = 'Another subject';
		await nextTick();
		await vi.advanceTimersByTimeAsync(1500);
		expect(saves().at(-1)?.args).toMatchObject({
			campaignId: 'cmp_1',
			abTest: { enabled: true, testType: 'subject', variantBSubject: 'Another subject' },
		});
		expect(form.drafts.autosave.atRisk.value).toBe(false);
	});

	it('keeps an unfinished audience choice at risk although the campaign never had one', async () => {
		const { form } = await setup(null, { ...DRAFT, audience: undefined });
		form.campaignAudience.audienceType.value = 'segment';
		await nextTick();
		expect(form.drafts.autosave.atRisk.value).toBe(true);
		await vi.advanceTimersByTimeAsync(1600);
		// Nothing a draft can store: no write, and no write acknowledged the choice.
		expect(saves()).toHaveLength(0);
		expect(form.drafts.autosave.atRisk.value).toBe(true);
	});

	it('shows a refused background save instead of toasting it, and keeps the edit', async () => {
		const { form } = await setup();
		failNext = true;
		form.campaignName.value = 'x'.repeat(300);
		await nextTick();
		await vi.advanceTimersByTimeAsync(1500);

		expect(form.drafts.autosave.status.value).toBe('error');
		expect(form.campaignName.value).toBe('x'.repeat(300));
		expect(showToast).not.toHaveBeenCalled();

		// Retry sends the same section again.
		form.drafts.autosave.retry();
		await vi.advanceTimersByTimeAsync(0);
		expect(saves()).toHaveLength(2);
		expect(form.drafts.autosave.status.value).toBe('saved');
	});

	it('discards: nothing of the edit is saved on the way out', async () => {
		const { form, unmount } = await setup();
		form.campaignName.value = 'Discarded name';
		await nextTick();
		expect(await leave()).toBe(false);
		form.confirmDiscard();
		expect(routes.push).toHaveBeenCalledWith('/dashboard/campaigns');
		unmount();
		await vi.advanceTimersByTimeAsync(5000);
		expect(saves()).toHaveLength(0);
	});

	it('waits while the leave prompt is open, and saves once the person stays', async () => {
		const { form } = await setup();
		form.campaignName.value = 'Edited name';
		await nextTick();
		expect(await leave()).toBe(false);
		expect(form.showUnsavedChangesDialog.value).toBe(true);
		await vi.advanceTimersByTimeAsync(5000);
		expect(saves()).toHaveLength(0);

		form.cancelNavigation();
		await vi.advanceTimersByTimeAsync(1500);
		expect(saves().map((run) => run.args)).toEqual([{ campaignId: 'cmp_1', name: 'Edited name' }]);
	});

	it("saves a partial draft from the prompt's Save without the send checks, then leaves", async () => {
		const { form, validate } = await setup('Choose who this campaign comes from.');
		form.campaignSubject.value = '';
		await nextTick();
		expect(await leave()).toBe(false);

		await form.confirmSave();
		expect(validate).not.toHaveBeenCalled();
		expect(saves().map((run) => run.args)).toEqual([
			{ campaignId: 'cmp_1', content: { emailTemplateId: 'tpl_1', subject: '' } },
		]);
		expect(routes.push).toHaveBeenCalledWith('/dashboard/campaigns');
	});

	it('holds background saves while the email opens in a new tab, and keeps the edits after', async () => {
		const { form } = await setup();
		form.campaignName.value = 'Edited name';
		await nextTick();
		const leaveDecision = form.drafts.autosave.leave;
		expect(await leaveDecision.request('/dashboard/send/emails/tpl_1/edit', 'open-tab')).toBe(
			false
		);
		expect(leaveDecision.tabChoosing.value).toBe(true);
		expect(form.showUnsavedChangesDialog.value).toBe(false);
		await vi.advanceTimersByTimeAsync(5000);
		expect(saves()).toHaveLength(0);

		// "Open without saving": the tab opens, and this page keeps and saves its edits.
		expect(leaveDecision.discard()).toBe('/dashboard/send/emails/tpl_1/edit');
		await vi.advanceTimersByTimeAsync(1500);
		expect(saves().map((run) => run.args)).toEqual([{ campaignId: 'cmp_1', name: 'Edited name' }]);
	});
});

describe('useCampaignForm schedule choices', () => {
	beforeEach(() => {
		vi.useFakeTimers();
		draftStore = memoryStore().store;
	});
	afterEach(() => {
		vi.useRealTimers();
	});

	const pick = async (form: Awaited<ReturnType<typeof setup>>['form']) => {
		form.scheduledDate.value = '2099-11-02';
		form.scheduledTime.value = '09:00';
		await nextTick();
	};

	it('keeps an unscheduled date guarded although the draft is saved and its copy committed', async () => {
		const { form } = await setup();
		await pick(form);
		form.campaignName.value = 'Renamed';
		await nextTick();
		await vi.advanceTimersByTimeAsync(1600);
		await saveLanded(form);

		// The draft's own sections saved; the schedule went nowhere.
		expect(saves().map((run) => run.args)).toEqual([{ campaignId: 'cmp_1', name: 'Renamed' }]);
		expect(form.drafts.autosave.atRisk.value).toBe(true);
		expect(form.drafts.autosave.status.value).toBe('scheduling');
		expect(await leave()).toBe(false);
	});

	it("says why the prompt's Save does not let the page go, and lets Discard", async () => {
		const { form } = await setup();
		await pick(form);
		expect(await leave()).toBe(false);
		await form.confirmSave();
		expect(routes.push).not.toHaveBeenCalled();
		expect(showToast).toHaveBeenCalledWith(t('shared.draftAutosave.schedulingDetail'), 'error');
		form.confirmDiscard();
		expect(routes.push).toHaveBeenCalledWith('/dashboard/campaigns');
	});

	it('keeps the schedule at risk when Schedule fails after its save', async () => {
		const { form } = await setup();
		await pick(form);
		form.campaignName.value = 'Renamed';
		await nextTick();
		failLabel = t('shared.useCampaignActions.operations.schedule');

		await form.handleSchedule();
		expect(saves()).toHaveLength(1);
		// Not scheduled: the chosen date and time are still worth a warning.
		expect(form.drafts.autosave.atRisk.value).toBe(true);
		await vi.advanceTimersByTimeAsync(1500);
		expect(form.drafts.autosave.atRisk.value).toBe(true);
	});

	it('lets a completed Schedule take the schedule, after the background save it waited for', async () => {
		const { form } = await setup();
		holdLabel = 'Save campaign draft';
		form.campaignName.value = 'Renamed';
		await nextTick();
		await vi.advanceTimersByTimeAsync(1500);
		expect(saves()).toHaveLength(1);
		await pick(form);

		const scheduling = form.handleSchedule();
		// The action began and waits for the save in flight: no second save, no schedule yet.
		expect(form.drafts.autosave.state.value.action).not.toBeNull();
		expect(saves()).toHaveLength(1);
		expect(
			runs.some((run) => run.label === t('shared.useCampaignActions.operations.schedule'))
		).toBe(false);
		holdLabel = null;
		for (const release of held.splice(0)) release();
		await scheduling;
		expect(runs.map((run) => run.label)).toEqual([
			'Save campaign draft',
			t('shared.useCampaignActions.operations.schedule'),
		]);
		expect(form.drafts.autosave.atRisk.value).toBe(false);
	});

	it('stops instead of scheduling a form that changed after its save', async () => {
		const { form, abTest } = await setup();
		abTest.abTestEnabled.value = true;
		abTest.abVariantBSubject.value = 'Variant B';
		await pick(form);
		// The A/B write after the draft save is slow; the subject changes meanwhile.
		holdLabel = t('shared.useCampaignActions.operations.enableABTest');
		const scheduling = form.handleSchedule();
		await until(() => held.length === 1);
		form.campaignSubject.value = 'Changed after its save';
		await nextTick();
		holdLabel = null;
		held.shift()!();
		await scheduling;

		const schedule = t('shared.useCampaignActions.operations.schedule');
		expect(runs.some((run) => run.label === schedule)).toBe(false);
		expect(form.saveError.value).toBe(t('shared.draftAutosave.changedDuringAction'));
		// The schedule stays a guarded choice, and the newer subject saves in the background.
		expect(form.drafts.autosave.atRisk.value).toBe(true);
		await vi.advanceTimersByTimeAsync(1500);
		expect(saves().at(-1)?.args).toMatchObject({
			content: { subject: 'Changed after its save' },
		});
	});
});

describe('useCampaignForm device copy', () => {
	let memory: ReturnType<typeof memoryStore>;
	beforeEach(() => {
		vi.useFakeTimers();
		memory = memoryStore();
		draftStore = memory.store;
	});
	afterEach(() => {
		vi.useRealTimers();
	});

	const scope = editorDraftScope({
		userId: 'user_1',
		organizationId: 'org_1',
		kind: 'campaign',
		id: 'cmp_1',
	});
	const copies = async () => draftStore!.list(scope, (data): data is unknown => true);
	/** An audience type picked without a list: the device keeps it after a save. */
	const pickUnfinished = async (form: Awaited<ReturnType<typeof setup>>['form']) => {
		form.campaignAudience.audienceType.value = 'topic';
		await nextTick();
		await vi.advanceTimersByTimeAsync(300);
		await copyCommitted(form);
	};

	it('leaves the schedule out of the copy', async () => {
		const { form } = await setup();
		form.scheduledDate.value = '2099-11-02';
		await pickUnfinished(form);
		const [copy] = await copies();
		expect(copy?.data).not.toHaveProperty('scheduledDate');
		expect(copy?.data).toMatchObject({ audienceType: 'topic' });
	});

	it('names the campaign as loaded, not a newer write by someone else', async () => {
		const { form } = await setup();
		form.campaignName.value = 'My name';
		await nextTick();
		campaign.value = { ...DRAFT, replyTo: 'their@owlat.example', updatedAt: 200 };
		await nextTick();
		await vi.advanceTimersByTimeAsync(300);
		await copyCommitted(form);

		// The copy holds the reply-to as loaded; a newer base would let it pass for one made after theirs.
		expect((await copies()).map(({ base }) => base)).toEqual([100]);
	});

	it('moves on with its own save when nobody else wrote in between', async () => {
		const { form } = await setup();
		landed = { campaignId: 'cmp_1', updatedAt: 150, previousUpdatedAt: 100 };
		form.campaignName.value = 'My name';
		await nextTick();
		await vi.advanceTimersByTimeAsync(1500);
		await pickUnfinished(form);

		expect((await copies()).map(({ base }) => base)).toEqual([150]);
	});

	it("stays on the campaign as loaded when its save lands on someone else's write", async () => {
		const { form } = await setup();
		landed = { campaignId: 'cmp_1', updatedAt: 300, previousUpdatedAt: 200 };
		form.campaignName.value = 'My name';
		await nextTick();
		await vi.advanceTimersByTimeAsync(1500);
		await pickUnfinished(form);

		expect((await copies()).map(({ base }) => base)).toEqual([100]);
	});

	it('offers an older copy holding a schedule, and restores it as a guarded choice', async () => {
		memory.data.set(editorDraftKey(scope, 'tab-old.1'), {
			v: 1,
			savedAt: Date.now(),
			base: 100,
			data: {
				name: 'Offline name',
				fromName: 'Owlat news',
				fromEmail: 'news@owlat.example',
				replyTo: '',
				audienceType: 'segment',
				topicId: null,
				segmentId: 'sg_1',
				templateId: 'tpl_1',
				subject: 'What is new',
				archiveEnabled: false,
				scheduledDate: '2099-11-02',
				scheduledTime: '09:00',
				sendTiming: { mode: 'instant', windowHours: 24, holdoutPercent: 10 },
				abTest: {
					enabled: false,
					type: 'subject',
					variantBSubject: '',
					variantBTemplateId: null,
					split: 20,
					criteria: 'open_rate',
					duration: 4,
				},
			},
		});
		const { form } = await setup();
		await until(() => form.drafts.recovery.pending.value !== null);
		// Built on the very `updatedAt` loaded: still only offered.
		expect(form.campaignName.value).toBe('September newsletter');
		expect(form.drafts.recovery.pending.value?.data).toMatchObject({ name: 'Offline name' });
		await vi.advanceTimersByTimeAsync(1500);
		expect(saves()).toHaveLength(0);

		form.drafts.recovery.restore();
		await nextTick();
		expect(form.campaignName.value).toBe('Offline name');
		expect(form.scheduledDate.value).toBe('2099-11-02');
		await vi.advanceTimersByTimeAsync(1500);
		expect(saves().map((run) => run.args)).toEqual([{ campaignId: 'cmp_1', name: 'Offline name' }]);
		expect(form.drafts.autosave.status.value).toBe('scheduling');
		expect(form.drafts.autosave.atRisk.value).toBe(true);
	});
});
