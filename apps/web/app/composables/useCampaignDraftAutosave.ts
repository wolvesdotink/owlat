import { computed, type Ref } from 'vue';
import { api } from '@owlat/api';
import type { Doc, Id } from '@owlat/api/dataModel';
import type { FunctionArgs } from 'convex/server';
import type { OperationError } from '@owlat/shared/operationError';
import { sendTimingFromCampaign, type SendTiming } from '~/lib/sendTiming';
import { editorDraftKey } from '~/utils/editorDraftStore';
import type { useCampaignABTest } from './useCampaignABTest';
import type { CampaignAudienceSelection, CampaignAudienceType } from './useCampaignAudience';
import { useDraftAutosave, type DraftAutosave } from './useDraftAutosave';
import { useDraftRecovery, type DraftRecovery } from './useDraftRecovery';
import { SaveRefusedError } from './useEditorSaveOperation';

/**
 * The campaign editor's autosave: the draft campaign form saved in the
 * background through `campaigns.drafts.saveDraft` (`useDraftAutosave.ts`),
 * with a device copy for edits the server has not got (`useDraftRecovery.ts`).
 *
 * A save sends only the sections that changed since the last one landed, so
 * an editor open in two tabs does not write one tab's stale copy of a section
 * over the other's newer edit of it. A section that is not complete yet (no
 * list picked, an A/B test without its Variant B) stays on the device until it
 * is; so do the schedule choices, which a draft does not store.
 */

type ABTest = ReturnType<typeof useCampaignABTest>;
type SaveDraftArgs = FunctionArgs<typeof api.campaigns.drafts.saveDraft>;
type DraftPayload = Omit<SaveDraftArgs, 'campaignId'>;

/** Everything the form holds, as the device keeps it. */
export interface CampaignDraftSnapshot {
	name: string;
	fromName: string;
	fromEmail: string;
	replyTo: string;
	audienceType: CampaignAudienceType;
	topicId: string | null;
	segmentId: string | null;
	templateId: string | null;
	subject: string;
	archiveEnabled: boolean;
	scheduledDate: string;
	scheduledTime: string;
	sendTiming: SendTiming;
	abTest: {
		enabled: boolean;
		type: 'subject' | 'content';
		variantBSubject: string;
		variantBTemplateId: string | null;
		split: number;
		criteria: 'open_rate' | 'click_rate' | 'manual';
		duration: number;
	};
}

export interface CampaignDraftForm<Submission> {
	campaignId: Ref<Id<'campaigns'>>;
	campaignData: Ref<
		| Pick<
				Doc<'campaigns'>,
				'updatedAt' | 'audience' | 'useRecipientTimezone' | 'sendTimeOptimization'
		  >
		| null
		| undefined
	>;
	isDraft: () => boolean;
	isInitialized: () => boolean;
	/** Send, Schedule or the explicit save is running. */
	isActing: () => boolean;
	hasChanges: () => boolean;
	beginSubmit: () => Submission;
	acknowledge: (submission: Submission) => void;
	changes: (() => unknown)[];
	campaignName: Ref<string>;
	fromName: Ref<string>;
	fromEmail: Ref<string>;
	replyTo: Ref<string>;
	audienceType: Ref<CampaignAudienceType>;
	selectedTopicId: Ref<Id<'topics'> | null>;
	selectedSegmentId: Ref<Id<'segments'> | null>;
	audience: Ref<CampaignAudienceSelection | null>;
	selectedTemplateId: Ref<Id<'emailTemplates'> | null>;
	campaignSubject: Ref<string>;
	archiveEnabled: Ref<boolean>;
	scheduledDate: Ref<string>;
	scheduledTime: Ref<string>;
	sendTiming: Ref<SendTiming>;
	abTest: ABTest;
	/** A restored sender: the picker re-reads the From it shows. */
	onSenderRestored: () => void;
}

export interface CampaignDraftAutosave {
	autosave: DraftAutosave;
	recovery: DraftRecovery<CampaignDraftSnapshot>;
	/** The whole draft as `saveDraft` takes it (the explicit save before Send). */
	payload: () => DraftPayload;
	/**
	 * The server holds `payload` (the form was just loaded from it, or a save
	 * of it landed): later autosaves send only what changes after it.
	 */
	markSent: (payload: DraftPayload) => void;
}

const isSnapshot = (data: unknown): data is CampaignDraftSnapshot => {
	if (typeof data !== 'object' || data === null) return false;
	const draft = data as Partial<CampaignDraftSnapshot>;
	return (
		typeof draft.name === 'string' &&
		typeof draft.fromEmail === 'string' &&
		typeof draft.subject === 'string' &&
		typeof draft.abTest === 'object' &&
		typeof draft.sendTiming === 'object'
	);
};

export function useCampaignDraftAutosave<Submission>(
	form: CampaignDraftForm<Submission>
): CampaignDraftAutosave {
	const { user, activeOrganizationId } = useAuth();
	const { t } = useI18n();
	const { showToast } = useToast();
	const { abTest } = form;

	let refusal: OperationError | null = null;
	const { run: saveDraft } = useBackendOperation(api.campaigns.drafts.saveDraft, {
		label: () => t('shared.useCampaignForm.operations.saveDraft'),
		// The status beside the title shows a failed background save.
		onError: (op) => {
			refusal = op;
			return true;
		},
		announce: false,
	});

	const abTestComplete = () => abTest.abTestEnabled.value && abTest.validate() === null;

	/** The sections `saveDraft` can store now; incomplete ones are left out. */
	const payload = (): DraftPayload => {
		const selected = form.audience.value;
		const templateId = form.selectedTemplateId.value;
		const draft: DraftPayload = {
			name: form.campaignName.value.trim(),
			fromName: form.fromName.value.trim(),
			fromEmail: form.fromEmail.value.trim(),
			replyTo: form.replyTo.value.trim(),
			archiveEnabled: form.archiveEnabled.value,
		};
		if (selected) draft.audience = selected;
		if (templateId) {
			draft.content = { emailTemplateId: templateId, subject: form.campaignSubject.value.trim() };
		}
		if (!abTest.abTestEnabled.value) draft.abTest = { enabled: false };
		else if (abTestComplete()) {
			const { campaignId: _campaignId, ...setup } = abTest.buildEnablePayload(
				form.campaignId.value
			);
			draft.abTest = { enabled: true, ...setup };
		}
		return draft;
	};

	// What the server holds, per section, as of the last save that landed.
	let sent: Record<string, string> = {};
	const markSent = (draft: DraftPayload) => {
		sent = {
			...sent,
			...Object.fromEntries(Object.entries(draft).map(([k, v]) => [k, JSON.stringify(v)])),
		};
	};

	const snapshot = (): CampaignDraftSnapshot => ({
		name: form.campaignName.value,
		fromName: form.fromName.value,
		fromEmail: form.fromEmail.value,
		replyTo: form.replyTo.value,
		audienceType: form.audienceType.value,
		topicId: form.selectedTopicId.value,
		segmentId: form.selectedSegmentId.value,
		templateId: form.selectedTemplateId.value,
		subject: form.campaignSubject.value,
		archiveEnabled: form.archiveEnabled.value,
		scheduledDate: form.scheduledDate.value,
		scheduledTime: form.scheduledTime.value,
		sendTiming: { ...form.sendTiming.value },
		abTest: {
			enabled: abTest.abTestEnabled.value,
			type: abTest.abTestType.value,
			variantBSubject: abTest.abVariantBSubject.value,
			variantBTemplateId: abTest.abVariantBTemplateId.value,
			split: abTest.abSplitPercentage.value,
			criteria: abTest.abWinnerCriteria.value,
			duration: abTest.abTestDuration.value,
		},
	});

	/** Choices only the device holds: worth keeping after a save landed. */
	const holdsDeviceOnly = (draft: CampaignDraftSnapshot) =>
		draft.scheduledDate !== '' ||
		draft.scheduledTime !== '' ||
		JSON.stringify(draft.sendTiming) !==
			JSON.stringify(sendTimingFromCampaign(form.campaignData.value ?? {})) ||
		(draft.abTest.enabled && !abTestComplete()) ||
		(form.audience.value === null && form.campaignData.value?.audience != null) ||
		(draft.templateId === null && draft.subject.trim() !== '');

	const key = computed(() => {
		const userId = user.value?.id;
		const organizationId = activeOrganizationId.value;
		return userId && organizationId
			? editorDraftKey({ userId, organizationId, kind: 'campaign', id: form.campaignId.value })
			: null;
	});

	const ready = () => form.isDraft() && form.isInitialized();

	const autosave = useDraftAutosave<CampaignDraftSnapshot>({
		enabled: ready,
		paused: form.isActing,
		dirty: form.hasChanges,
		changes: form.changes,
		save: async () => {
			const submission = form.beginSubmit();
			const draft = payload();
			const changed = Object.fromEntries(
				Object.entries(draft).filter(([k, v]) => sent[k] !== JSON.stringify(v))
			) as DraftPayload;
			if (Object.keys(changed).length > 0) {
				refusal = null;
				const outcome = await saveDraft({ campaignId: form.campaignId.value, ...changed });
				const refused = refusal as OperationError | null;
				if (!outcome.ok) {
					throw refused ? new SaveRefusedError(refused) : new Error('Saving the campaign failed');
				}
				markSent(changed);
			}
			form.acknowledge(submission);
		},
		mirror: {
			key: () => key.value,
			snapshot,
			base: () => form.campaignData.value?.updatedAt ?? null,
			keepAfterSave: holdsDeviceOnly,
		},
	});

	const apply = (data: CampaignDraftSnapshot) => {
		form.campaignName.value = data.name;
		form.fromName.value = data.fromName;
		form.fromEmail.value = data.fromEmail;
		form.replyTo.value = data.replyTo;
		form.audienceType.value = data.audienceType;
		form.selectedTopicId.value = data.topicId as Id<'topics'> | null;
		form.selectedSegmentId.value = data.segmentId as Id<'segments'> | null;
		form.selectedTemplateId.value = data.templateId as Id<'emailTemplates'> | null;
		form.campaignSubject.value = data.subject;
		form.archiveEnabled.value = data.archiveEnabled;
		form.scheduledDate.value = data.scheduledDate;
		form.scheduledTime.value = data.scheduledTime;
		form.sendTiming.value = { ...data.sendTiming };
		abTest.abTestEnabled.value = data.abTest.enabled;
		abTest.abTestType.value = data.abTest.type;
		abTest.abVariantBSubject.value = data.abTest.variantBSubject;
		abTest.abVariantBTemplateId.value = data.abTest
			.variantBTemplateId as Id<'emailTemplates'> | null;
		abTest.abSplitPercentage.value = data.abTest.split;
		abTest.abWinnerCriteria.value = data.abTest.criteria;
		abTest.abTestDuration.value = data.abTest.duration;
		form.onSenderRestored();
	};

	const recovery = useDraftRecovery<CampaignDraftSnapshot>({
		key: () => key.value,
		ready,
		accept: isSnapshot,
		matches: (data) => JSON.stringify(data) === JSON.stringify(snapshot()),
		canApply: (copy) => copy.base !== null && copy.base === form.campaignData.value?.updatedAt,
		apply,
		onApplied: () => showToast(t('shared.draftAutosave.restored')),
	});

	return { autosave, recovery, payload, markSent };
}
