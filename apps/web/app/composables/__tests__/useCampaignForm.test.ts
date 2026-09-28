/**
 * The campaign edit page runs the wizard's recipients and sender controls.
 *
 * `useCampaignForm` used to keep its own copy of the audience state and a
 * free-text From address that it checked only for shape, so an address off the
 * curated list got as far as `updateBasics` and was refused there. The sender
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
	guardDirty = ref(false);
	campaign = ref(undefined);
	vi.stubGlobal('useI18n', () => i18n.global);
	vi.stubGlobal('useRouter', () => ({ push: vi.fn() }));
	vi.stubGlobal('useToast', () => ({ showToast: vi.fn() }));
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
		(_reference: unknown, options: { label: string | (() => string) }) => ({
			run: async (args: unknown) => {
				const label = typeof options.label === 'function' ? options.label() : options.label;
				runs.push({ label, args });
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
	const form = useCampaignForm(ref('cmp_1' as Id<'campaigns'>), useCampaignABTest(), picker);
	campaign.value = { ...DRAFT };
	await nextTick();
	await nextTick();
	return { form, validate };
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
		const basics = runs.find((run) => run.label === 'Update campaign basics');
		expect(basics?.args).toMatchObject({ fromEmail: 'team@owlat.example' });
		const audience = runs.find((run) => run.label === 'Update campaign audience');
		expect(audience?.args).toMatchObject({ audience: { kind: 'segment', segmentId: 'sg_1' } });
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
