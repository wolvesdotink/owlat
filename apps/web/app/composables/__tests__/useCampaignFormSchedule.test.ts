/**
 * The campaign edit page's send-time choices and its final actions.
 *
 * Save draft stores the form's fields, not the date, time and delivery
 * options: only a completed Schedule does. So leaving keeps asking about an
 * unscheduled choice after Save draft, and the prompt's Save says why it did
 * not let the page go. Send and Schedule save the form first and dispatch
 * only what the form showed when they began: an edit made while their saves
 * ran stops them, and the form stays unsaved. Leaving goes through the real
 * unsaved-changes guard.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { nextTick, reactive, ref, type Ref } from 'vue';
import type { Id } from '@owlat/api/dataModel';
import { createTestI18n } from '~/__tests__/i18n';
import { until } from '~/__tests__/until';
import { withSetup } from '~/__tests__/withSetup';
import type { SenderPickerHandle } from '~/utils/campaignSenderPicker';

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
/** Runs with this label wait for the test. */
let holdLabel: string | null;
let held: (() => void)[];
let showToast: ReturnType<typeof vi.fn>;

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
		(_reference: unknown, options: { label: string | (() => string) }) => ({
			run: async (args: unknown) => {
				const label = typeof options.label === 'function' ? options.label() : options.label;
				runs.push({ label, args });
				if (label === holdLabel) await new Promise<void>((resolve) => held.push(resolve));
				return label === failLabel ? { ok: false } : { ok: true, result: null };
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
};

async function setup() {
	vi.stubGlobal('useUnsavedChanges', useUnsavedChanges);
	const picker = ref<SenderPickerHandle | null>({ validate: () => null, isReady: true });
	const page = withSetup(() => {
		const abTest = useCampaignABTest();
		return { abTest, form: useCampaignForm(ref('cmp_1' as Id<'campaigns'>), abTest, picker) };
	});
	campaign.value = { ...DRAFT };
	await nextTick();
	await nextTick();
	await nextTick();
	return { ...page.result, unmount: page.unmount };
}

/** Runs the page's leave guard; resolves whether it let the page go. */
async function leave(to = '/dashboard/campaigns') {
	let answer: unknown = 'none';
	await routes.guards.at(-1)?.({ fullPath: to }, {}, (value?: unknown) => {
		answer = value;
	});
	return answer !== false;
}

type Form = Awaited<ReturnType<typeof setup>>['form'];
const pick = async (form: Form) => {
	form.scheduledDate.value = '2099-11-02';
	form.scheduledTime.value = '09:00';
	await nextTick();
};
const labels = () => runs.map((run) => run.label);
const SCHEDULE = () => t('shared.useCampaignActions.operations.schedule');
const ENABLE_AB = () => t('shared.useCampaignActions.operations.enableABTest');

describe('useCampaignForm send-time choices', () => {
	it('keeps an unscheduled date guarded after Save draft stored the fields', async () => {
		const { form } = await setup();
		await pick(form);
		form.campaignName.value = 'Renamed';
		await nextTick();
		expect(await form.handleSave()).toBe(true);
		await nextTick();

		expect(labels()).toContain(t('shared.useCampaignForm.operations.updateBasics'));
		expect(labels()).not.toContain(SCHEDULE());
		expect(form.hasUnsavedChanges.value).toBe(true);
		expect(await leave()).toBe(false);
	});

	it("says why the prompt's Save does not let the page go, and lets Discard", async () => {
		const { form } = await setup();
		await pick(form);
		expect(await leave()).toBe(false);
		await form.confirmSave();
		expect(routes.push).not.toHaveBeenCalled();
		expect(form.showUnsavedChangesDialog.value).toBe(true);
		expect(showToast).toHaveBeenCalledWith(
			t('shared.useCampaignForm.toasts.scheduleNotSaved'),
			'warning'
		);
		form.confirmDiscard();
		expect(routes.push).toHaveBeenCalledWith('/dashboard/campaigns');
	});

	it('lets the page go after Save draft when no send-time choice changed', async () => {
		const { form } = await setup();
		form.campaignName.value = 'Renamed';
		await nextTick();
		expect(await leave()).toBe(false);
		await form.confirmSave();
		expect(routes.push).toHaveBeenCalledWith('/dashboard/campaigns');
	});

	it('keeps the form and the schedule unsaved when Schedule fails after its save', async () => {
		const { form } = await setup();
		await pick(form);
		form.campaignName.value = 'Renamed';
		await nextTick();
		failLabel = SCHEDULE();

		await form.handleSchedule();
		await nextTick();
		expect(labels()).toContain(SCHEDULE());
		expect(form.hasUnsavedChanges.value).toBe(true);
		expect(await leave()).toBe(false);
	});

	it('takes the schedule once Schedule completed', async () => {
		const { form } = await setup();
		await pick(form);
		await form.handleSchedule();
		await nextTick();
		expect(labels().at(-1)).toBe(SCHEDULE());
		expect(form.hasUnsavedChanges.value).toBe(false);
		expect(await leave()).toBe(true);
	});
});

describe('useCampaignForm final actions', () => {
	/** A/B on, so its slow write lands between the field saves and the final mutation. */
	async function withSlowABWrite() {
		const page = await setup();
		page.abTest.abTestEnabled.value = true;
		page.abTest.abVariantBSubject.value = 'Variant B';
		await pick(page.form);
		holdLabel = ENABLE_AB();
		return page;
	}
	const releaseHeld = () => {
		holdLabel = null;
		held.shift()!();
	};

	it('stops instead of scheduling a form that changed after its save', async () => {
		const { form } = await withSlowABWrite();
		const scheduling = form.handleSchedule();
		await until(() => held.length === 1);
		form.campaignSubject.value = 'Changed after its save';
		await nextTick();
		releaseHeld();
		await scheduling;

		expect(labels()).not.toContain(SCHEDULE());
		expect(form.saveError.value).toBe(t('shared.draftAutosave.changedDuringAction'));
		// Nothing was marked saved: the newer subject is still unsaved.
		expect(form.hasUnsavedChanges.value).toBe(true);
		expect(await leave()).toBe(false);
	});

	it('stops Schedule when its send time changed after its save, but not Send', async () => {
		const scheduled = await withSlowABWrite();
		const scheduling = scheduled.form.handleSchedule();
		await until(() => held.length === 1);
		scheduled.form.scheduledTime.value = '10:30';
		await nextTick();
		releaseHeld();
		await scheduling;
		expect(labels()).not.toContain(SCHEDULE());
		scheduled.unmount();

		runs = [];
		const sent = await withSlowABWrite();
		const sending = sent.form.handleSendNow();
		await until(() => held.length === 1);
		sent.form.scheduledTime.value = '10:30';
		await nextTick();
		releaseHeld();
		await sending;
		// Send now ignores the send-time choices: it goes out one undo window from now.
		expect(runs.at(-1)).toMatchObject({
			label: SCHEDULE(),
			args: { useRecipientTimezone: false },
		});
		sent.unmount();
	});

	it('dispatches nothing once the page is gone', async () => {
		const { form, unmount } = await withSlowABWrite();
		const scheduling = form.handleSchedule();
		await until(() => held.length === 1);
		unmount();
		releaseHeld();
		await scheduling;
		expect(labels()).not.toContain(SCHEDULE());
	});
});
