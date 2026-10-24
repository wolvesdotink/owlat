/**
 * The campaign edit page runs the wizard's recipients and sender controls.
 *
 * `useCampaignForm` used to keep its own copy of the audience state and a
 * free-text From address that it checked only for shape, so an address off the
 * curated list got as far as the save and was refused there. The sender
 * picker's `validate()` now guards the save, and the picker's own settling of
 * the loaded From must not look like an unsaved edit.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { nextTick, ref, type Ref } from 'vue';
import type { Id } from '@owlat/api/dataModel';
import { createTestI18n } from '~/__tests__/i18n';
import type { SenderPickerHandle } from '~/utils/campaignSenderPicker';
import {
	createEditorDraftStore,
	editorDraftScope,
	type EditorDraftStore,
} from '~/utils/editorDraftStore';
import { createNoopDriver } from '~/utils/postboxOfflineKvDriver';

// A test that needs device copies sets `draftStore`; the rest run without one.
let draftStore: EditorDraftStore | null = null;
vi.mock('~/utils/editorDraftStore', async (importOriginal) => {
	const actual: { getEditorDraftStore: () => EditorDraftStore } = await importOriginal();
	return { ...actual, getEditorDraftStore: () => draftStore ?? actual.getEditorDraftStore() };
});

const i18n = createTestI18n();

let campaign: Ref<Record<string, unknown> | undefined>;
let runs: { label: string; args: unknown }[];
let guardDirty: Ref<boolean>;
/** The leave prompt (useUnsavedChanges' dialog) is open. */
let leaveDialog: Ref<boolean>;
/** The next run's outcome, for the background-save cases. */
let failNext: boolean;
/** Runs with this label fail. */
let failLabel: string | null;
let showToast: ReturnType<typeof vi.fn>;
/** The leave prompt's Save (useUnsavedChanges' `onSave`). */
let leaveSave: (() => Promise<void>) | undefined;
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

beforeEach(() => {
	runs = [];
	landed = null;
	draftStore = null;
	failNext = false;
	failLabel = null;
	showToast = vi.fn();
	guardDirty = ref(false);
	leaveDialog = ref(false);
	campaign = ref(undefined);
	vi.stubGlobal('useI18n', () => i18n.global);
	vi.stubGlobal('useRouter', () => ({ push: vi.fn() }));
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
	vi.stubGlobal('useUnsavedChanges', (opts: { onSave?: () => Promise<void> }) => {
		leaveSave = opts.onSave;
		return {
			showDialog: leaveDialog,
			hasUnsavedChanges: guardDirty,
			confirmDiscard: vi.fn(),
			confirmSave: vi.fn(),
			cancelNavigation: vi.fn(),
			setHasChanges: (dirty: boolean) => {
				guardDirty.value = dirty;
			},
		};
	});
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
};

async function setup(senderProblem: string | null = null, row: Record<string, unknown> = DRAFT) {
	const validate = vi.fn(() => senderProblem);
	const picker = ref<SenderPickerHandle | null>({ validate, isReady: senderProblem === null });
	const abTest = useCampaignABTest();
	const form = useCampaignForm(ref('cmp_1' as Id<'campaigns'>), abTest, picker);
	campaign.value = { ...row };
	await nextTick();
	await nextTick();
	return { form, validate, abTest };
}

describe('useCampaignForm on the wizard controls', () => {
	it('hydrates the recipients from the saved campaign', async () => {
		const { form } = await setup();
		expect(form.campaignAudience.audienceType.value).toBe('segment');
		expect(form.audience.value).toEqual({ kind: 'segment', segmentId: 'sg_1' });
		expect(guardDirty.value).toBe(false);
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
		expect(await form.handleSave()).toBe(true);
		expect(form.errors.value).toEqual({});
		// One write for the whole form, the sender and recipients with it.
		const saves = runs.filter((run) => run.label === 'Save campaign draft');
		expect(saves).toHaveLength(1);
		expect(saves[0]?.args).toMatchObject({
			fromEmail: 'team@owlat.example',
			audience: { kind: 'segment', segmentId: 'sg_1' },
			content: { emailTemplateId: 'tpl_1', subject: 'What is new' },
		});
	});

	it('keeps a clean form clean when the picker settles the loaded sender', async () => {
		const { form } = await setup();
		// The picker writes the curated row's current name, then says it did.
		form.fromName.value = 'Owlat';
		form.onSenderPreselected();
		await nextTick();
		await nextTick();
		expect(guardDirty.value).toBe(false);

		// A user edit afterwards still arms the guard.
		form.fromEmail.value = 'hello@owlat.example';
		await nextTick();
		expect(guardDirty.value).toBe(true);
	});

	it('leaves an already edited form dirty when the picker settles', async () => {
		const { form } = await setup();
		form.replyTo.value = 'support@owlat.example';
		await nextTick();
		expect(guardDirty.value).toBe(true);

		form.fromName.value = 'Owlat';
		form.onSenderPreselected();
		await nextTick();
		await nextTick();
		expect(guardDirty.value).toBe(true);
	});
});

describe('useCampaignForm autosave', () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});
	afterEach(() => {
		vi.useRealTimers();
	});

	const saves = () => runs.filter((run) => run.label === 'Save campaign draft');

	it('saves only the section that changed, without a Save button', async () => {
		const { form } = await setup();
		form.replyTo.value = 'support@owlat.example';
		await nextTick();
		await vi.advanceTimersByTimeAsync(1500);

		expect(saves().map((run) => run.args)).toEqual([
			{ campaignId: 'cmp_1', replyTo: 'support@owlat.example' },
		]);
		expect(form.drafts.autosave.status.value).toBe('saved');
		expect(guardDirty.value).toBe(false);
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

	it('leaves an A/B test out until it is complete', async () => {
		const { form, abTest } = await setup();
		abTest.abTestEnabled.value = true;
		form.archiveEnabled.value = true;
		await nextTick();
		await vi.advanceTimersByTimeAsync(1500);
		expect(saves().at(-1)?.args).toEqual({ campaignId: 'cmp_1', archiveEnabled: true });

		abTest.abVariantBSubject.value = 'Another subject';
		await nextTick();
		await vi.advanceTimersByTimeAsync(1500);
		expect(saves().at(-1)?.args).toMatchObject({
			campaignId: 'cmp_1',
			abTest: { enabled: true, testType: 'subject', variantBSubject: 'Another subject' },
		});
	});

	it('shows a refused background save instead of toasting it, and keeps the edit', async () => {
		const { form } = await setup();
		failNext = true;
		form.campaignName.value = 'x'.repeat(300);
		await nextTick();
		await vi.advanceTimersByTimeAsync(1500);

		expect(form.drafts.autosave.status.value).toBe('error');
		expect(form.campaignName.value).toBe('x'.repeat(300));

		// Retry sends the same section again.
		form.drafts.autosave.retry();
		await vi.advanceTimersByTimeAsync(0);
		expect(saves()).toHaveLength(2);
		expect(form.drafts.autosave.status.value).toBe('saved');
	});

	// The test environment has no IndexedDB: nothing can be kept on the device.
	it('keeps a schedule choice at risk when this browser cannot keep it', async () => {
		const { form } = await setup();
		form.scheduledDate.value = '2026-11-02';
		form.scheduledTime.value = '09:00';
		await nextTick();
		await vi.advanceTimersByTimeAsync(1500);

		// A draft does not store the schedule, so nothing went to the server.
		expect(saves()).toHaveLength(0);
		expect(form.drafts.autosave.status.value).toBe('unkept');
		expect(guardDirty.value).toBe(true);
	});

	it('saves nothing of a discarded edit on the way out', async () => {
		const { form } = await setup();
		form.campaignName.value = 'Discarded name';
		await nextTick();
		form.confirmDiscard();
		await vi.advanceTimersByTimeAsync(5000);
		expect(saves()).toHaveLength(0);
	});

	it('saves nothing while the Edit email prompt is open, nor after opening without saving', async () => {
		const { form } = await setup();
		form.campaignName.value = 'Edited name';
		await nextTick();
		form.showEditEmailPrompt.value = true;
		await vi.advanceTimersByTimeAsync(5000);
		expect(saves()).toHaveLength(0);

		// "Open without saving" on desktop: the prompt closes, the edits go.
		form.showEditEmailPrompt.value = false;
		form.drafts.autosave.cancel();
		await vi.advanceTimersByTimeAsync(5000);
		expect(saves()).toHaveLength(0);
	});

	it("keeps the guard when the prompt's Save leaves a schedule kept nowhere", async () => {
		const { form } = await setup();
		form.scheduledDate.value = '2099-11-02';
		form.scheduledTime.value = '09:00';
		await nextTick();
		leaveDialog.value = true;

		// No IndexedDB here: the device cannot keep the schedule a draft does not store.
		expect(await form.saveFromPrompt()).toBe(false);
		expect(guardDirty.value).toBe(true);
		expect(form.drafts.autosave.atRisk.value).toBe(true);
		expect(showToast).toHaveBeenCalledWith(
			i18n.global.t('shared.draftAutosave.unkeptDetail'),
			'error'
		);
		// The prompt's own Save: no failure to throw, the armed guard keeps the prompt up.
		await expect(leaveSave!()).resolves.toBeUndefined();
		expect(guardDirty.value).toBe(true);
		// The page staying open (the email opens in a new tab) keeps it, so that Save may go on.
		expect(await form.saveFromPrompt(true)).toBe(true);
		expect(guardDirty.value).toBe(true);
	});

	it("saves a partial draft from the prompt's Save without the send checks", async () => {
		const { form, validate } = await setup('Choose who this campaign comes from.');
		form.campaignSubject.value = '';
		await nextTick();
		leaveDialog.value = true;

		await leaveSave!();
		expect(validate).not.toHaveBeenCalled();
		expect(saves().map((run) => run.args)).toEqual([
			{ campaignId: 'cmp_1', content: { emailTemplateId: 'tpl_1', subject: '' } },
		]);
		expect(guardDirty.value).toBe(false);
	});

	it('keeps the schedule at risk when Schedule fails after its save', async () => {
		const { form } = await setup();
		form.scheduledDate.value = '2099-11-02';
		form.scheduledTime.value = '09:00';
		await nextTick();
		failLabel = i18n.global.t('shared.useCampaignActions.operations.schedule');

		await form.handleSchedule();
		expect(saves()).toHaveLength(1);
		// Not scheduled: the chosen date and time are still worth a warning.
		expect(guardDirty.value).toBe(true);
		await vi.advanceTimersByTimeAsync(1500);
		expect(guardDirty.value).toBe(true);
	});

	it('waits for the leave prompt, and saves once the person stays', async () => {
		const { form } = await setup();
		form.campaignName.value = 'Edited name';
		await nextTick();
		leaveDialog.value = true;
		await vi.advanceTimersByTimeAsync(5000);
		expect(saves()).toHaveLength(0);

		leaveDialog.value = false;
		await nextTick();
		await vi.advanceTimersByTimeAsync(1500);
		expect(saves().map((run) => run.args)).toEqual([{ campaignId: 'cmp_1', name: 'Edited name' }]);
	});
});

describe('useCampaignForm device copy base', () => {
	beforeEach(() => {
		vi.useFakeTimers();
		const data = new Map<string, unknown>();
		draftStore = createEditorDraftStore({
			...createNoopDriver(),
			persistent: true,
			get: async <T>(key: string) => data.get(key) as T,
			set: async (key, value) => {
				data.set(key, value);
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
		});
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
	const copyBases = async () =>
		(await draftStore!.list(scope, (data): data is unknown => true)).map(({ copy }) => copy.base);
	/** A schedule a draft does not store: its copy stays after a save. */
	const pickSchedule = async (form: Awaited<ReturnType<typeof setup>>['form']) => {
		form.scheduledDate.value = '2099-11-02';
		form.scheduledTime.value = '09:00';
		await nextTick();
		await vi.advanceTimersByTimeAsync(300);
	};

	it('names the campaign as loaded, not a newer write by someone else', async () => {
		const { form } = await setup(null, { ...DRAFT, updatedAt: 100 });
		form.campaignName.value = 'My name';
		await nextTick();
		campaign.value = { ...DRAFT, replyTo: 'their@owlat.example', updatedAt: 200 };
		await nextTick();
		await vi.advanceTimersByTimeAsync(300);

		// The copy holds the reply-to as loaded; a newer base would let it be applied over theirs.
		expect(await copyBases()).toEqual([100]);
	});

	it('moves on with its own save when nobody else wrote in between', async () => {
		const { form } = await setup(null, { ...DRAFT, updatedAt: 100 });
		landed = { campaignId: 'cmp_1', updatedAt: 150, previousUpdatedAt: 100 };
		form.campaignName.value = 'My name';
		await nextTick();
		await vi.advanceTimersByTimeAsync(1500);
		await pickSchedule(form);

		expect(await copyBases()).toEqual([150]);
	});

	it("stays on the campaign as loaded when its save lands on someone else's write", async () => {
		const { form } = await setup(null, { ...DRAFT, updatedAt: 100 });
		landed = { campaignId: 'cmp_1', updatedAt: 300, previousUpdatedAt: 200 };
		form.campaignName.value = 'My name';
		await nextTick();
		await vi.advanceTimersByTimeAsync(1500);
		await pickSchedule(form);

		expect(await copyBases()).toEqual([100]);
	});
});
