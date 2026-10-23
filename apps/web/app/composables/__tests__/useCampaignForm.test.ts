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

const i18n = createTestI18n();

let campaign: Ref<Record<string, unknown> | undefined>;
let runs: { label: string; args: unknown }[];
let guardDirty: Ref<boolean>;
/** The next run's outcome, for the background-save cases. */
let failNext: boolean;

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
	failNext = false;
	guardDirty = ref(false);
	campaign = ref(undefined);
	vi.stubGlobal('useI18n', () => i18n.global);
	vi.stubGlobal('useRouter', () => ({ push: vi.fn() }));
	vi.stubGlobal('useToast', () => ({ showToast: vi.fn() }));
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
	vi.stubGlobal('useUnsavedChanges', () => ({
		showDialog: ref(false),
		hasUnsavedChanges: guardDirty,
		confirmDiscard: vi.fn(),
		confirmSave: vi.fn(),
		cancelNavigation: vi.fn(),
		setHasChanges: (dirty: boolean) => {
			guardDirty.value = dirty;
		},
	}));
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
				if (failNext) {
					failNext = false;
					options.onError?.({ category: 'invalid_input', message: 'Name is too long' });
					return { ok: false };
				}
				return { ok: true, result: null };
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

async function setup(senderProblem: string | null = null) {
	const validate = vi.fn(() => senderProblem);
	const picker = ref<SenderPickerHandle | null>({ validate, isReady: senderProblem === null });
	const abTest = useCampaignABTest();
	const form = useCampaignForm(ref('cmp_1' as Id<'campaigns'>), abTest, picker);
	campaign.value = { ...DRAFT };
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
});
