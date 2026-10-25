import { computed, watch, type Ref } from 'vue';
import { api } from '@owlat/api';
import type { Doc, Id } from '@owlat/api/dataModel';
import type { FunctionArgs } from 'convex/server';
import type { OperationError } from '@owlat/shared/operationError';
import { operationCopy, resolveOperationCopy } from '~/lib/operationError';
import type { SendTiming } from '~/lib/sendTiming';
import { canonicalJson } from '@owlat/shared/canonicalJson';
import type { Fingerprints } from '~/utils/draftSession';
import { editorDraftScope } from '~/utils/editorDraftStore';
import type { useCampaignABTest } from './useCampaignABTest';
import type { CampaignAudienceSelection, CampaignAudienceType } from './useCampaignAudience';
import { useDraftAutosave, type DraftAutosave } from './useDraftAutosave';
import type { DraftRecovery } from './useDraftRecovery';
import { SaveRefusedError } from './useEditorSaveOperation';

/**
 * The campaign editor's autosave: binds the draft campaign form to its
 * session (`useDraftAutosave.ts`), which owns the draft while the campaign is
 * a draft; the form's manual tracker owns it otherwise (a scheduled campaign).
 *
 * A save (`campaigns.drafts.saveDraft`) carries only the sections that differ
 * from what the server holds, and only those count as saved when it lands.
 * This keeps a second tab's edit of another section from being overwritten;
 * an edit of the same section in two tabs is still last-writer-wins (a draft
 * save has no compare-and-swap). A section that is not complete yet (no list
 * picked, no email, an A/B test without its Variant B) is a choice only the
 * device copy holds until it is. The schedule (date, time, delivery options)
 * is in neither: a draft does not store it and its copy leaves it out, so it
 * keeps the leave guard until Schedule takes it, or Discard drops it.
 */

type ABTest = ReturnType<typeof useCampaignABTest>;
type SaveDraftArgs = FunctionArgs<typeof api.campaigns.drafts.saveDraft>;
type DraftPayload = Omit<SaveDraftArgs, 'campaignId'>;

/** Everything the form holds, as the device keeps it (the schedule only in older copies). */
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
	scheduledDate?: string;
	scheduledTime?: string;
	sendTiming?: SendTiming;
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

/** The schedule's field: no draft save and no device copy hold it. */
export const SCHEDULE_FIELD = 'schedule';

export interface CampaignDraftForm {
	campaignId: Ref<Id<'campaigns'>>;
	campaignData: Ref<Pick<Doc<'campaigns'>, 'updatedAt'> | null | undefined>;
	isDraft: () => boolean;
	/** The form's manual tracker: it holds the form while the campaign is not a draft. */
	tracker: {
		isInitialized: Readonly<Ref<boolean>>;
		hasChanges: Readonly<Ref<boolean>>;
		/** Take the form back (built on the latest row), dirty when the session had unsaved work. */
		resume: (base: null, dirty: boolean) => void;
	};
	/** Values that change with every edit. */
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
	autosave: DraftAutosave<CampaignDraftSnapshot>;
	recovery: DraftRecovery<CampaignDraftSnapshot>;
	/** The form was just loaded from the campaign: the server holds what it shows. */
	markLoaded: () => void;
	/**
	 * The form settled what it loaded (the sender picker wrote the loaded
	 * sender's current details): still the server's state, not an edit.
	 */
	markSettled: () => void;
	/** The whole form as `saveDraft` takes it, complete sections only. */
	payload: () => DraftPayload;
	/**
	 * Save what is pending before Send or Schedule; false (with a toast) when
	 * it did not land.
	 */
	saveBeforeAction: () => Promise<boolean>;
}

const isSnapshot = (data: unknown): data is CampaignDraftSnapshot => {
	if (typeof data !== 'object' || data === null) return false;
	const draft = data as Partial<CampaignDraftSnapshot>;
	return (
		typeof draft.name === 'string' &&
		typeof draft.fromEmail === 'string' &&
		typeof draft.subject === 'string' &&
		typeof draft.abTest === 'object'
	);
};

const fingerprint = (value: unknown) => JSON.stringify(value) ?? 'undefined';

export function useCampaignDraftAutosave(form: CampaignDraftForm): CampaignDraftAutosave {
	const { user, activeOrganizationId } = useAuth();
	const { t, locale, te } = useI18n();
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

	const abTestSetup = () => ({
		enabled: abTest.abTestEnabled.value,
		type: abTest.abTestType.value,
		variantBSubject: abTest.abVariantBSubject.value,
		variantBTemplateId: abTest.abVariantBTemplateId.value,
		split: abTest.abSplitPercentage.value,
		criteria: abTest.abWinnerCriteria.value,
		duration: abTest.abTestDuration.value,
	});

	/** The form as fingerprints per section, and the sections no draft save can hold yet. */
	const read = (): { values: Fingerprints; deviceOnly: string[] } => ({
		values: {
			name: fingerprint(form.campaignName.value),
			fromName: fingerprint(form.fromName.value),
			fromEmail: fingerprint(form.fromEmail.value),
			replyTo: fingerprint(form.replyTo.value),
			archiveEnabled: fingerprint(form.archiveEnabled.value),
			audience: fingerprint([
				form.audienceType.value,
				form.selectedTopicId.value,
				form.selectedSegmentId.value,
			]),
			content: fingerprint([form.selectedTemplateId.value, form.campaignSubject.value]),
			abTest: fingerprint(abTestSetup()),
			[SCHEDULE_FIELD]: fingerprint([
				form.scheduledDate.value,
				form.scheduledTime.value,
				form.sendTiming.value,
			]),
		},
		deviceOnly: [
			...(form.audience.value === null ? ['audience'] : []),
			...(form.selectedTemplateId.value === null ? ['content'] : []),
			...(abTest.abTestEnabled.value && abTest.validate() !== null ? ['abTest'] : []),
		],
	});

	/** What `saveDraft` takes for `sections`, read from the form now. */
	const payloadFor = (sections: readonly string[]): DraftPayload => {
		const has = (section: string) => sections.includes(section);
		const draft: DraftPayload = {};
		if (has('name')) draft.name = form.campaignName.value.trim();
		if (has('fromName')) draft.fromName = form.fromName.value.trim();
		if (has('fromEmail')) draft.fromEmail = form.fromEmail.value.trim();
		if (has('replyTo')) draft.replyTo = form.replyTo.value.trim();
		if (has('archiveEnabled')) draft.archiveEnabled = form.archiveEnabled.value;
		const selected = form.audience.value;
		if (has('audience') && selected) draft.audience = selected;
		const templateId = form.selectedTemplateId.value;
		if (has('content') && templateId) {
			draft.content = { emailTemplateId: templateId, subject: form.campaignSubject.value.trim() };
		}
		if (has('abTest')) {
			if (!abTest.abTestEnabled.value) draft.abTest = { enabled: false };
			else {
				const { campaignId: _campaignId, ...setup } = abTest.buildEnablePayload(
					form.campaignId.value
				);
				draft.abTest = { enabled: true, ...setup };
			}
		}
		return draft;
	};

	/** The copy: everything but the schedule. */
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
		abTest: abTestSetup(),
	});

	const scope = computed(() => {
		const userId = user.value?.id;
		const organizationId = activeOrganizationId.value;
		return userId && organizationId
			? editorDraftScope({ userId, organizationId, kind: 'campaign', id: form.campaignId.value })
			: null;
	});

	const failureCopy = (error: unknown) =>
		error instanceof SaveRefusedError
			? resolveOperationCopy(
					operationCopy(error.op, { locale: locale.value, hasMessage: (key) => te(key) }),
					t
				)
			: t('shared.draftAutosave.notSavedYet');

	const autosave: DraftAutosave<CampaignDraftSnapshot> = useDraftAutosave<CampaignDraftSnapshot>({
		enabled: () => form.isDraft() && form.tracker.isInitialized.value,
		scope: () => scope.value,
		read,
		snapshot,
		volatile: [SCHEDULE_FIELD],
		persist: async (flight) => {
			const draft = payloadFor(flight.included);
			refusal = null;
			const outcome = await saveDraft({ campaignId: form.campaignId.value, ...draft });
			const refused = refusal as OperationError | null;
			if (!outcome.ok) {
				throw refused ? new SaveRefusedError(refused) : new Error('Saving the campaign failed');
			}
			// From one transaction: what `updatedAt` was, and what this save left.
			return { lineage: { from: outcome.result.previousUpdatedAt, to: outcome.result.updatedAt } };
		},
		accept: isSnapshot,
		matches: (data) =>
			canonicalJson(data) === canonicalJson({ ...snapshot(), ...scheduleOf(data) }),
		apply: (data) => {
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
			// A copy from before the schedule was left out: the choice comes back
			// as a choice, guarded until Schedule.
			if (data.scheduledDate !== undefined) form.scheduledDate.value = data.scheduledDate;
			if (data.scheduledTime !== undefined) form.scheduledTime.value = data.scheduledTime;
			if (data.sendTiming) form.sendTiming.value = { ...data.sendTiming };
			abTest.abTestEnabled.value = data.abTest.enabled;
			abTest.abTestType.value = data.abTest.type;
			abTest.abVariantBSubject.value = data.abTest.variantBSubject;
			abTest.abVariantBTemplateId.value = data.abTest
				.variantBTemplateId as Id<'emailTemplates'> | null;
			abTest.abSplitPercentage.value = data.abTest.split;
			abTest.abWinnerCriteria.value = data.abTest.criteria;
			abTest.abTestDuration.value = data.abTest.duration;
			form.onSenderRestored();
		},
		onRefused: (reason) =>
			showToast(
				reason === 'schedule'
					? t('shared.draftAutosave.schedulingDetail')
					: reason === 'unkept'
						? t('shared.draftAutosave.unkeptDetail')
						: failureCopy(autosave.error.value),
				'error'
			),
	});

	/** The form's schedule, for comparing an older copy that holds one (a newer copy has none). */
	function scheduleOf(data: CampaignDraftSnapshot) {
		return data.scheduledDate === undefined
			? {}
			: {
					scheduledDate: form.scheduledDate.value,
					scheduledTime: form.scheduledTime.value,
					sendTiming: { ...form.sendTiming.value },
				};
	}

	const edited = () => {
		if (form.isDraft()) {
			const reading = read();
			autosave.edit(reading.values, reading.deviceOnly);
		}
	};
	watch(form.changes, edited);

	/** The form as the server holds it now: the session's base. */
	const markLoaded = () => {
		const reading = read();
		autosave.dispatch({
			type: 'hydrated',
			revision: form.campaignData.value?.updatedAt ?? null,
			values: reading.values,
			deviceOnly: reading.deviceOnly,
			fresh: false,
		});
	};

	// Scheduled → draft (Unschedule): the session takes the form over, with
	// what the manual tracker held unsaved. Draft → scheduled: back to it.
	watch(form.isDraft, (draft, was) => {
		if (draft === was || !form.tracker.isInitialized.value) return;
		if (!draft) {
			form.tracker.resume(null, autosave.dirty.value);
			return;
		}
		const reading = read();
		autosave.dispatch({
			type: 'transfer',
			revision: form.campaignData.value?.updatedAt ?? null,
			values: reading.values,
			deviceOnly: reading.deviceOnly,
			dirty: form.tracker.hasChanges.value,
		});
	});

	const markSettled = () => {
		autosave.dispatch({
			type: 'rebaseline',
			hydration: autosave.state.value.hydration,
			values: read().values,
		});
	};

	const saveBeforeAction = async () => {
		if (await autosave.flush()) return true;
		showToast(failureCopy(autosave.error.value), 'error');
		return false;
	};

	const payload = () => {
		const { values, deviceOnly } = read();
		return payloadFor(Object.keys(values).filter((section) => !deviceOnly.includes(section)));
	};

	return {
		autosave,
		recovery: autosave.recovery,
		markLoaded,
		markSettled,
		payload,
		saveBeforeAction,
	};
}
