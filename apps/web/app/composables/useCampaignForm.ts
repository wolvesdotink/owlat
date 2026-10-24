import { ref, computed, nextTick, watch, type Ref } from 'vue';
import { api } from '@owlat/api';
import type { Id } from '@owlat/api/dataModel';
import type { SenderPickerHandle } from '~/utils/campaignSenderPicker';
import type { useCampaignABTest } from './useCampaignABTest';
import { useCampaignActions } from './useCampaignActions';
import { useCampaignAudience } from './useCampaignAudience';
import { useEditorDirtyTracking } from './useEditorDirtyTracking';
import { useCampaignDraftAutosave } from './useCampaignDraftAutosave';

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
 * whose `validate()` guards the save before Send and Schedule (`senderPicker`
 * is its template ref). A draft saves itself as it is edited
 * (useCampaignDraftAutosave); Send and Schedule stay explicit.
 */
export function useCampaignForm(
	campaignId: Ref<Id<'campaigns'>>,
	abTest: ABTest,
	senderPicker: Ref<SenderPickerHandle | null>
) {
	const { t, locale } = useI18n();
	const { showToast } = useToast();

	// ─── Data Fetching ──────────────────────────────────────────────────

	const {
		data: campaignData,
		isLoading: campaignLoading,
		error: campaignError,
		refetch: refetchCampaign,
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

	const { run: saveDraft } = useBackendOperation(api.campaigns.drafts.saveDraft, {
		label: () => t('shared.useCampaignForm.operations.saveDraft'),
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

	// The whole validated form in one write, before Send and Schedule. Returns
	// whether it landed so useCampaignActions can abort the rest of the
	// sequence; `run` self-toasts its categorized error. A complete A/B test
	// goes with it (the per-section enable that follows cannot change the
	// setup of a test that is already on).
	const handleSaveFields = async (): Promise<boolean> => {
		if (!audience.value) {
			errors.value.audience = t('shared.useCampaignForm.errors.audienceRequired');
			return false;
		}
		const fields = drafts.payload();
		const result = await saveDraft({ campaignId: campaignId.value, ...fields });
		if (result.ok) drafts.markSent(fields, result.result);
		return result.ok;
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

	// Reuses the shared composable + dialog. `onSave` closes over
	// `saveFromPrompt` (assigned below) and only runs after the user confirms
	// "Save", by which point it exists; it throws on a failed save so the user
	// stays on the page. A draft whose save landed but whose device-only
	// choices are kept nowhere stays too: its guard is still armed.
	const {
		showDialog: showUnsavedChangesDialog,
		isSavingBeforeLeave,
		hasUnsavedChanges,
		confirmDiscard,
		confirmSave,
		cancelNavigation,
		setHasChanges,
	} = useUnsavedChanges({
		onSave: async () => {
			if (await saveFromPrompt()) return;
			if (!(isDraft.value && drafts.autosave.status.value === 'unkept')) {
				throw new Error('Save failed');
			}
		},
	});

	// The save-or-discard prompt for opening the linked email (the page's).
	const showEditEmailPrompt = ref(false);

	// Clears the dirty flag (and retires the device copy) after a successful
	// save/schedule/send so the route guard doesn't prompt on the action's own
	// navigation. Bound below once the dirty tracker exists.
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
	const tracked = [
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
		() => actions.sendTiming.value.mode,
		() => actions.sendTiming.value.windowHours,
		() => actions.sendTiming.value.holdoutPercent,
		() => abTest.abTestEnabled.value,
		() => abTest.abTestType.value,
		() => abTest.abVariantBSubject.value,
		() => abTest.abVariantBTemplateId.value,
		() => abTest.abSplitPercentage.value,
		() => abTest.abWinnerCriteria.value,
		() => abTest.abTestDuration.value,
	];
	// Bound below once the autosave exists: the form as just loaded is what
	// the server holds.
	let onFormLoaded: () => void = () => {};
	const { markClean, hasChanges, beginSubmit, acknowledge } = useEditorDirtyTracking({
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

			actions.initializeSchedule(campaign.scheduledAt, campaign);
			abTest.initializeFromCampaign(campaign);

			isFormInitialized.value = true;
			onFormLoaded();
		},
		watchSources: tracked,
	});

	// The From picker settles its selection once; a restored sender remounts it.
	const senderPickerKey = ref(0);
	const drafts = useCampaignDraftAutosave({
		campaignId,
		campaignData,
		isDraft: () => isDraft.value,
		isInitialized: () => isFormInitialized.value,
		isActing: () => actions.isSaving.value,
		// Nothing saves in the background while a prompt offers to discard it.
		isChoosing: () => showUnsavedChangesDialog.value || showEditEmailPrompt.value,
		hasChanges: () => hasChanges.value,
		beginSubmit,
		acknowledge,
		changes: tracked,
		campaignName,
		fromName,
		fromEmail,
		replyTo,
		audienceType,
		selectedTopicId,
		selectedSegmentId,
		audience,
		selectedTemplateId,
		campaignSubject,
		archiveEnabled,
		scheduledDate: actions.scheduledDate,
		scheduledTime: actions.scheduledTime,
		sendTiming: actions.sendTiming,
		abTest,
		onSenderRestored: () => {
			senderPickerKey.value += 1;
		},
	});
	onFormLoaded = () => drafts.markLoaded();
	if (isFormInitialized.value) onFormLoaded();
	markCleanForm = () => {
		markClean();
		drafts.autosave.cancel();
	};

	// The Save of a save-or-discard prompt. A draft saves the way autosave
	// does: what is complete goes to the server, without the checks Send and
	// Schedule need, and what a draft cannot store (the schedule, an unfinished
	// section) stays in this device's copy for the next visit. Nothing is
	// discarded. Resolves false while something would still be lost, unless
	// the page `staysOpen` (the linked email opens in a new tab) and keeps it.
	const saveFromPrompt = async (staysOpen = false): Promise<boolean> => {
		if (!isDraft.value) return actions.handleSave();
		if (!(await drafts.autosave.flush())) {
			showToast(t('shared.draftAutosave.notSavedYet'), 'error');
			return false;
		}
		if (staysOpen || !drafts.autosave.atRisk.value) return true;
		showToast(t('shared.draftAutosave.unkeptDetail'), 'error');
		return false;
	};

	// Leaving warns about edits that would be lost: for a draft, only one
	// neither saved nor kept on this device.
	watch(
		() => (isDraft.value ? drafts.autosave.atRisk.value : hasChanges.value),
		(guard) => setHasChanges(guard),
		{ immediate: true }
	);

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
		refetchCampaign,
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
		sendTiming: actions.sendTiming,

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

		// Autosave (drafts) and the From picker's remount key
		drafts,
		senderPickerKey,

		// Unsaved-changes guard
		showUnsavedChangesDialog,
		showEditEmailPrompt,
		isSavingBeforeLeave,
		hasUnsavedChanges,
		// Discard: nothing of the draft's edits is saved on the way out.
		confirmDiscard: () => {
			drafts.autosave.cancel();
			confirmDiscard();
		},
		confirmSave,
		cancelNavigation,
		onSenderPreselected,
		saveFromPrompt,

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
