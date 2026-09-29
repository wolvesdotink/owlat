import { ref, computed, nextTick, type Ref } from 'vue';
import { api } from '@owlat/api';
import type { Id } from '@owlat/api/dataModel';
import type { SenderPickerHandle } from '~/utils/campaignSenderPicker';
import type { useCampaignABTest } from './useCampaignABTest';
import { useCampaignActions } from './useCampaignActions';
import { useCampaignAudience } from './useCampaignAudience';
import { useEditorDirtyTracking } from './useEditorDirtyTracking';

type ABTest = ReturnType<typeof useCampaignABTest>;

export interface CampaignFormErrors {
	campaignName?: string;
	audience?: string;
	content?: string;
	subject?: string;
	schedule?: string;
}

/**
 * Composable for managing the campaign edit form.
 *
 * Delegates action handlers to useCampaignActions and
 * test-email sending to the CampaignsTestEmailModal component. The recipients
 * come from useCampaignAudience and the From from the wizard's sender picker,
 * whose `validate()` guards every save (`senderPicker` is its template ref).
 */
export function useCampaignForm(
	campaignId: Ref<Id<'campaigns'>>,
	abTest: ABTest,
	senderPicker: Ref<SenderPickerHandle | null>
) {
	const { t, locale } = useI18n();

	// ─── Data Fetching ──────────────────────────────────────────────────

	const {
		data: campaignData,
		isLoading: campaignLoading,
		error: campaignError,
	} = useConvexQuery(api.campaigns.campaigns.getWithRelations, () => ({
		campaignId: campaignId.value,
	}));

	const campaignAudience = useCampaignAudience();
	const { audienceType, selectedTopicId, selectedSegmentId, audience } = campaignAudience;

	const { results: emailTemplates } = useOrganizationPaginatedQuery(
		api.emailTemplates.emails.list,
		{ type: 'marketing' as const },
		{ initialNumItems: 100 }
	);

	// Archive-default for new campaigns comes from the `campaigns.archive`
	// feature flag, not a separate instanceSettings column.
	const { flags } = useFeatureFlag();

	// ─── Form State ─────────────────────────────────────────────────────

	const campaignName = ref('');
	const fromName = ref('');
	const fromEmail = ref('');
	const replyTo = ref('');
	const selectedTemplateId = ref<Id<'emailTemplates'> | null>(null);
	const campaignSubject = ref('');
	const archiveEnabled = ref(flags.value['campaigns.archive'] === true);

	const isFormInitialized = ref(false);
	const errors = ref<CampaignFormErrors>({});

	// ─── Mutations (for save) ───────────────────────────────────────────

	const { run: updateBasics } = useBackendOperation(api.campaigns.campaigns.updateBasics, {
		label: () => t('shared.useCampaignForm.operations.updateBasics'),
	});
	const { run: updateAudience } = useBackendOperation(api.campaigns.campaigns.updateAudience, {
		label: () => t('shared.useCampaignForm.operations.updateAudience'),
	});
	const { run: updateContent } = useBackendOperation(api.campaigns.campaigns.updateContent, {
		label: () => t('shared.useCampaignForm.operations.updateContent'),
	});

	// ─── Validation ─────────────────────────────────────────────────────

	const validateForm = (): boolean => {
		errors.value = {};

		if (!campaignName.value.trim()) {
			errors.value.campaignName = t('shared.useCampaignForm.errors.campaignNameRequired');
		}

		// The sender picker shows its own error and mirrors the server's
		// curated-sender gate, so an address the save would be refused for never
		// reaches `updateBasics`.
		const senderProblem = senderPicker.value?.validate() ?? null;

		if (audienceType.value === 'topic' && !selectedTopicId.value) {
			errors.value.audience = t('shared.useCampaignForm.errors.topicRequired');
		}

		if (audienceType.value === 'segment' && !selectedSegmentId.value) {
			errors.value.audience = t('shared.useCampaignForm.errors.segmentRequired');
		}

		if (!selectedTemplateId.value) {
			errors.value.content = t('shared.useCampaignForm.errors.templateRequired');
		}

		if (!campaignSubject.value.trim()) {
			errors.value.subject = t('shared.useCampaignForm.errors.subjectRequired');
		}

		return senderProblem === null && Object.keys(errors.value).length === 0;
	};

	// ─── Field Save (used by actions) ───────────────────────────────────

	// Returns whether every field-save mutation succeeded so multi-step callers
	// (useCampaignActions) can abort the rest of the sequence on failure. Each
	// `run` self-toasts its categorized error and resolves to `undefined`.
	const handleSaveFields = async (): Promise<boolean> => {
		const basicsResult = await updateBasics({
			campaignId: campaignId.value,
			name: campaignName.value.trim(),
			fromName: fromName.value.trim() || undefined,
			fromEmail: fromEmail.value.trim(),
			replyTo: replyTo.value.trim() || undefined,
			archiveEnabled: archiveEnabled.value,
		});
		if (!basicsResult.ok) return false;

		if (!audience.value) {
			errors.value.audience = t('shared.useCampaignForm.errors.audienceRequired');
			return false;
		}
		const audienceResult = await updateAudience({
			campaignId: campaignId.value,
			audience: audience.value,
		});
		if (!audienceResult.ok) return false;

		const contentResult = await updateContent({
			campaignId: campaignId.value,
			emailTemplateId: selectedTemplateId.value!,
			subject: campaignSubject.value.trim(),
		});
		return contentResult.ok;
	};

	// ─── Computed Properties ────────────────────────────────────────────

	const selectedTemplate = computed(() => {
		if (!selectedTemplateId.value || !emailTemplates.value) return null;
		return emailTemplates.value.find((t) => t._id === selectedTemplateId.value) ?? null;
	});

	const isScheduled = computed(() => campaignData.value?.status === 'scheduled');
	const isDraft = computed(() => campaignData.value?.status === 'draft');
	const canEdit = computed(() => isDraft.value || isScheduled.value);

	const templateLanguages = computed(() => {
		if (!selectedTemplate.value) return [];
		const defaultLang = selectedTemplate.value.defaultLanguage ?? 'en';
		const supported = selectedTemplate.value.supportedLanguages ?? [];
		const langs = [defaultLang];
		for (const lang of supported) {
			if (lang !== defaultLang && !langs.includes(lang)) {
				langs.push(lang);
			}
		}
		return langs;
	});

	// ─── Unsaved-changes Guard ──────────────────────────────────────────

	// Reuses the shared composable + dialog. `onSave` closes over `actions`
	// (assigned below) and only runs after the user confirms "Save", by which
	// point it exists; it throws on a failed save so the user stays on the page.
	const {
		showDialog: showUnsavedChangesDialog,
		hasUnsavedChanges,
		confirmDiscard,
		confirmSave,
		cancelNavigation,
		setHasChanges,
	} = useUnsavedChanges({
		onSave: async () => {
			if (!(await actions.handleSave())) throw new Error('Save failed');
		},
	});

	// Clears the dirty flag after a successful save/schedule/send so the route
	// guard doesn't prompt on the action's own navigation. Bound below once the
	// dirty tracker exists.
	let markCleanForm: () => void = () => {};

	// ─── Actions (delegated) ────────────────────────────────────────────

	const actions = useCampaignActions({
		campaignId,
		abTest,
		campaignData,
		isDraft,
		isScheduled,
		validateForm,
		handleSaveFields,
		onSaved: () => markCleanForm(),
	});

	// ─── Form Initialization + Dirty Tracking ───────────────────────────

	// Load → dirty loop. Initializes the form from the campaign once, then flags
	// the form dirty on any subsequent field edit. The shared tracker defers its
	// "initialized" flag by a tick so the initial writes don't count as edits
	// (no false-positive "unsaved changes" on load).
	const { markClean, hasChanges } = useEditorDirtyTracking({
		source: campaignData,
		initialize: (campaign) => {
			if (isFormInitialized.value) return;
			campaignName.value = campaign.name;
			fromName.value = campaign.fromName ?? '';
			fromEmail.value = campaign.fromEmail ?? '';
			replyTo.value = campaign.replyTo ?? '';
			campaignAudience.hydrate(campaign.audience);
			selectedTemplateId.value = campaign.emailTemplateId ?? null;
			campaignSubject.value = campaign.subject ?? campaign.emailTemplate?.subject ?? '';
			archiveEnabled.value = campaign.archiveEnabled ?? flags.value['campaigns.archive'] === true;

			actions.initializeSchedule(campaign.scheduledAt, campaign.useRecipientTimezone);
			abTest.initializeFromCampaign(campaign);

			isFormInitialized.value = true;
		},
		watchSources: [
			() => campaignName.value,
			() => fromName.value,
			() => fromEmail.value,
			() => replyTo.value,
			() => audienceType.value,
			() => selectedTopicId.value,
			() => selectedSegmentId.value,
			() => selectedTemplateId.value,
			() => campaignSubject.value,
			() => archiveEnabled.value,
			() => actions.scheduledDate.value,
			() => actions.scheduledTime.value,
			() => actions.useRecipientTimezone.value,
			() => abTest.abTestEnabled.value,
			() => abTest.abTestType.value,
			() => abTest.abVariantBSubject.value,
			() => abTest.abVariantBTemplateId.value,
			() => abTest.abSplitPercentage.value,
			() => abTest.abWinnerCriteria.value,
			() => abTest.abTestDuration.value,
		],
		onDirtyChange: setHasChanges,
	});
	markCleanForm = markClean;

	// The sender picker settles the loaded From onto its curated row once, and
	// may write that sender's current name and address (or the default sender
	// when the saved one is gone). That write is the picker's, not the user's:
	// on a form nobody has touched it must not arm the leave guard. The dirty
	// flag is read before the write's watchers run, then cleared after them.
	const onSenderPreselected = () => {
		if (hasChanges.value) return;
		void nextTick(() => markClean());
	};

	// ─── Helpers ────────────────────────────────────────────────────────

	const formatDate = (dateStr: string, timeStr: string): string => {
		if (!dateStr || !timeStr) return '';
		const date = new Date(`${dateStr}T${timeStr}`);
		return new Intl.DateTimeFormat(locale.value, {
			weekday: 'long',
			year: 'numeric',
			month: 'long',
			day: 'numeric',
			hour: 'numeric',
			minute: '2-digit',
			hour12: true,
		}).format(date);
	};

	const getMinScheduleDate = () => {
		const now = new Date();
		now.setMinutes(now.getMinutes() + 5);
		return now.toISOString().slice(0, 10);
	};

	// The language codes the template picker offers. A code outside the catalog
	// keeps its uppercased self, exactly as before.
	const LANGUAGE_CODES = [
		'en',
		'de',
		'fr',
		'es',
		'it',
		'pt',
		'nl',
		'pl',
		'ru',
		'ja',
		'ko',
		'zh',
		'ar',
		'hi',
		'tr',
		'sv',
		'da',
		'no',
		'fi',
		'cs',
	];

	const getLanguageLabel = (code: string): string =>
		LANGUAGE_CODES.includes(code)
			? t(`shared.useCampaignForm.languages.${code}`)
			: code.toUpperCase();

	return {
		// Data
		campaignData,
		campaignLoading,
		campaignError,
		emailTemplates,
		/** Recipients: picker models, list subscriptions, derived `audience`, count. */
		campaignAudience,
		audienceCount: campaignAudience.audienceCount,
		/** The resolved audience selector, or `null` until one is chosen. */
		audience,

		// Form state
		campaignName,
		fromName,
		fromEmail,
		replyTo,
		selectedTemplateId,
		campaignSubject,
		archiveEnabled,
		scheduledDate: actions.scheduledDate,
		scheduledTime: actions.scheduledTime,
		scheduledStartAt: actions.scheduledStartAt,
		useRecipientTimezone: actions.useRecipientTimezone,

		// Computed
		selectedTemplate,
		isScheduled,
		isDraft,
		canEdit,
		templateLanguages,

		// Errors & loading
		errors,
		isSaving: actions.isSaving,
		saveError: actions.saveError,

		// Unsaved-changes guard
		showUnsavedChangesDialog,
		hasUnsavedChanges,
		confirmDiscard,
		confirmSave,
		cancelNavigation,
		onSenderPreselected,

		// Actions
		handleSave: actions.handleSave,
		handleSendNow: actions.handleSendNow,
		handleSchedule: actions.handleSchedule,
		handleUnschedule: actions.handleUnschedule,
		handleCancel: actions.handleCancel,
		handleBack: actions.handleBack,
		capacitySchedule: actions.capacitySchedule,
		dismissCapacitySchedule: actions.dismissCapacitySchedule,

		// Helpers
		validateForm,
		formatDate,
		getMinScheduleDate,
		getLanguageLabel,
	};
}
