import { ref, computed, watch, type Ref } from 'vue';
import { api } from '@owlat/api';
import type { Id } from '@owlat/api/dataModel';
import { emailRegex } from '@owlat/shared';
import type { useCampaignABTest } from './useCampaignABTest';
import { useCampaignActions } from './useCampaignActions';

type ABTest = ReturnType<typeof useCampaignABTest>;

export interface CampaignFormErrors {
	campaignName?: string;
	fromEmail?: string;
	audience?: string;
	content?: string;
	subject?: string;
	schedule?: string;
}

/**
 * Composable for managing the campaign edit form.
 *
 * Delegates action handlers to useCampaignActions and
 * test-email sending to the CampaignsTestEmailModal component.
 */
export function useCampaignForm(
	campaignId: Ref<Id<'campaigns'>>,
	abTest: ABTest
) {
	const { isPending: authPending, isAuthenticated } = useAuth();

	// ─── Data Fetching ──────────────────────────────────────────────────

	const { data: campaignData, isLoading: campaignLoading } = useConvexQuery(
		api.campaigns.campaigns.getWithRelations,
		() => ({ campaignId: campaignId.value })
	);

	const { results: topics } = useTopicsList();

	const { results: segments } = usePaginatedQuery(
		api.segments.list,
		() => {
			if (authPending.value || !isAuthenticated.value) return 'skip';
			return {};
		},
		{ initialNumItems: 100 }
	);

	const { results: emailTemplates } = usePaginatedQuery(
		api.emailTemplates.emails.list,
		() => {
			if (authPending.value || !isAuthenticated.value) return 'skip';
			return { type: 'marketing' as const };
		},
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
	const audienceType = ref<'topic' | 'segment'>('topic');
	const selectedTopicId = ref<Id<'topics'> | null>(null);
	const selectedSegmentId = ref<Id<'segments'> | null>(null);
	const selectedTemplateId = ref<Id<'emailTemplates'> | null>(null);
	const campaignSubject = ref('');
	const archiveEnabled = ref(flags.value['campaigns.archive'] === true);

	// One discriminated Audience value derived from the radio + dropdown state —
	// the single source of truth for the count query and the save mutation
	// (ADR-0033). Null until a complete topic/segment selection exists.
	const audience = computed(() => {
		if (audienceType.value === 'topic' && selectedTopicId.value) {
			return { kind: 'topic' as const, topicId: selectedTopicId.value };
		}
		if (audienceType.value === 'segment' && selectedSegmentId.value) {
			return { kind: 'segment' as const, segmentId: selectedSegmentId.value };
		}
		return null;
	});

	const isFormInitialized = ref(false);
	const errors = ref<CampaignFormErrors>({});

	// ─── Mutations (for save) ───────────────────────────────────────────

	const { run: updateBasics } = useBackendOperation(api.campaigns.campaigns.updateBasics, {
		label: 'Update campaign basics',
	});
	const { run: updateAudience } = useBackendOperation(api.campaigns.campaigns.updateAudience, {
		label: 'Update campaign audience',
	});
	const { run: updateContent } = useBackendOperation(api.campaigns.campaigns.updateContent, {
		label: 'Update campaign content',
	});

	// ─── Validation ─────────────────────────────────────────────────────

	const validateForm = (): boolean => {
		errors.value = {};

		if (!campaignName.value.trim()) {
			errors.value.campaignName = 'Campaign name is required';
		}

		if (!fromEmail.value.trim()) {
			errors.value.fromEmail = 'From email is required';
		} else if (!emailRegex.test(fromEmail.value.trim())) {
			errors.value.fromEmail = 'Please enter a valid email address';
		}

		if (audienceType.value === 'topic' && !selectedTopicId.value) {
			errors.value.audience = 'Please select a topic';
		}

		if (audienceType.value === 'segment' && !selectedSegmentId.value) {
			errors.value.audience = 'Please select a segment';
		}

		if (!selectedTemplateId.value) {
			errors.value.content = 'Please select an email template';
		}

		if (!campaignSubject.value.trim()) {
			errors.value.subject = 'Subject line is required';
		}

		return Object.keys(errors.value).length === 0;
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
		if (basicsResult === undefined) return false;

		if (!audience.value) {
			errors.value.audience = 'Please configure the campaign audience';
			return false;
		}
		const audienceResult = await updateAudience({
			campaignId: campaignId.value,
			audience: audience.value,
		});
		if (audienceResult === undefined) return false;

		const contentResult = await updateContent({
			campaignId: campaignId.value,
			emailTemplateId: selectedTemplateId.value!,
			subject: campaignSubject.value.trim(),
		});
		return contentResult !== undefined;
	};

	// ─── Computed Properties ────────────────────────────────────────────

	const selectedTemplate = computed(() => {
		if (!selectedTemplateId.value || !emailTemplates.value) return null;
		return emailTemplates.value.find((t) => t._id === selectedTemplateId.value) ?? null;
	});

	const isScheduled = computed(() => campaignData.value?.status === 'scheduled');
	const isDraft = computed(() => campaignData.value?.status === 'draft');
	const canEdit = computed(() => isDraft.value || isScheduled.value);

	const audienceDisplayText = computed(() => {
		if (audienceType.value === 'topic' && selectedTopicId.value) {
			const list = topics.value?.find(
				(l: { _id: string; name: string }) => l._id === selectedTopicId.value
			);
			return list ? `Topic: ${list.name}` : 'Topic';
		}
		if (audienceType.value === 'segment' && selectedSegmentId.value) {
			const segment = segments.value?.find(
				(s: { _id: string }) => s._id === selectedSegmentId.value
			);
			return segment ? `Segment: ${segment.name}` : 'Segment';
		}
		return 'Not configured';
	});

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

	// ─── Audience Count ─────────────────────────────────────────────────

	const { data: audienceCount } = useOrganizationQuery(
		api.campaigns.audienceResolution.countRecipients,
		() => ({ audience: audience.value ?? undefined })
	);

	// ─── Actions (delegated) ────────────────────────────────────────────

	const actions = useCampaignActions({
		campaignId,
		abTest,
		campaignData,
		isDraft,
		isScheduled,
		validateForm,
		handleSaveFields,
	});

	// ─── Test Email (delegated) ─────────────────────────────────────────


	// ─── Form Initialization ────────────────────────────────────────────

	watch(
		campaignData,
		(campaign) => {
			if (campaign && !isFormInitialized.value) {
				campaignName.value = campaign.name;
				fromName.value = campaign.fromName ?? '';
				fromEmail.value = campaign.fromEmail ?? '';
				replyTo.value = campaign.replyTo ?? '';
				audienceType.value = campaign.audience?.kind ?? 'topic';
				selectedTopicId.value =
					campaign.audience?.kind === 'topic' ? campaign.audience.topicId : null;
				selectedSegmentId.value =
					campaign.audience?.kind === 'segment' ? campaign.audience.segmentId : null;
				selectedTemplateId.value = campaign.emailTemplateId ?? null;
				campaignSubject.value = campaign.subject ?? campaign.emailTemplate?.subject ?? '';
				archiveEnabled.value = campaign.archiveEnabled ?? flags.value['campaigns.archive'] === true;

				actions.initializeSchedule(campaign.scheduledAt, campaign.useRecipientTimezone);
				abTest.initializeFromCampaign(campaign);

				isFormInitialized.value = true;
			}
		},
		{ immediate: true }
	);

	// ─── Helpers ────────────────────────────────────────────────────────

	const formatDate = (dateStr: string, timeStr: string): string => {
		if (!dateStr || !timeStr) return '';
		const date = new Date(`${dateStr}T${timeStr}`);
		return date.toLocaleString('en-US', {
			weekday: 'long',
			year: 'numeric',
			month: 'long',
			day: 'numeric',
			hour: 'numeric',
			minute: '2-digit',
			hour12: true,
		});
	};

	const getMinScheduleDate = () => {
		const now = new Date();
		now.setMinutes(now.getMinutes() + 5);
		return now.toISOString().slice(0, 10);
	};

	const getLanguageLabel = (code: string): string => {
		const labels: Record<string, string> = {
			en: 'English', de: 'German', fr: 'French', es: 'Spanish',
			it: 'Italian', pt: 'Portuguese', nl: 'Dutch', pl: 'Polish',
			ru: 'Russian', ja: 'Japanese', ko: 'Korean', zh: 'Chinese',
			ar: 'Arabic', hi: 'Hindi', tr: 'Turkish', sv: 'Swedish',
			da: 'Danish', no: 'Norwegian', fi: 'Finnish', cs: 'Czech',
		};
		return labels[code] ?? code.toUpperCase();
	};

	return {
		// Data
		campaignData,
		campaignLoading,
		topics,
		segments,
		emailTemplates,
		audienceCount,

		// Form state
		campaignName,
		fromName,
		fromEmail,
		replyTo,
		audienceType,
		selectedTopicId,
		selectedSegmentId,
		selectedTemplateId,
		campaignSubject,
		archiveEnabled,
		scheduledDate: actions.scheduledDate,
		scheduledTime: actions.scheduledTime,
		useRecipientTimezone: actions.useRecipientTimezone,

		// Computed
		selectedTemplate,
		isScheduled,
		isDraft,
		canEdit,
		audienceDisplayText,
		templateLanguages,

		// Errors & loading
		errors,
		isSaving: actions.isSaving,
		saveError: actions.saveError,

		// Test email

		// Actions
		handleSave: actions.handleSave,
		handleSendNow: actions.handleSendNow,
		handleSchedule: actions.handleSchedule,
		handleUnschedule: actions.handleUnschedule,
		handleCancel: actions.handleCancel,
		handleBack: actions.handleBack,

		// Helpers
		validateForm,
		formatDate,
		getMinScheduleDate,
		getLanguageLabel,
	};
}
