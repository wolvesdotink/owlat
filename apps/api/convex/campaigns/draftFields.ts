/**
 * Campaign draft fields: the validation and patch building shared by the
 * per-section edit mutations (`campaigns.ts` updateBasics / updateAudience /
 * updateContent, `abTest.ts` enableABTest) and the editor's autosave
 * (`drafts.ts` saveDraft). One home, so a rule tightened for one write path
 * cannot be skipped through the other.
 */

import type { MutationCtx } from '../_generated/server';
import type { Doc, Id } from '../_generated/dataModel';
import type { StoredAudience } from './audience';
import { getOrThrow, throwForbidden, throwInvalidInput } from '../_utils/errors';
import { getLiveOrThrow } from '../lib/softDelete';
import { validateStringLength, STRING_LIMITS, sanitizeEmailHeaderValue } from '../lib/inputGuards';
import {
	seedDefaultSenderIfNeeded,
	isCampaignSenderAllowed,
	senderNotAllowedMessage,
} from './senders';

export interface CampaignBasicsInput {
	name?: string;
	fromName?: string;
	fromEmail?: string;
	replyTo?: string;
	archiveEnabled?: boolean;
}

export interface CampaignBasicsPatch {
	name?: string;
	fromName?: string;
	fromEmail?: string;
	replyTo?: string;
	archiveEnabled?: boolean;
}

/**
 * The patch for the campaign's name, sender and archive choice. An address
 * that is set must pass the curated-sender gate, so no write path can persist
 * an off-list From; the verified-domain floor is enforced at send time.
 */
export async function campaignBasicsPatch(
	ctx: MutationCtx,
	args: CampaignBasicsInput
): Promise<CampaignBasicsPatch> {
	if (args.name) validateStringLength(args.name, STRING_LIMITS.NAME, 'Name');
	const patch: CampaignBasicsPatch = {};
	if (args.name !== undefined) patch.name = args.name.trim();
	if (args.fromName !== undefined) patch.fromName = sanitizeEmailHeaderValue(args.fromName);
	if (args.fromEmail !== undefined) {
		const fromEmail = args.fromEmail.trim();
		patch.fromEmail = fromEmail;
		if (fromEmail) {
			// Self-heal an upgraded deployment (empty curated list) so the org's own
			// default address stays usable, then enforce the curated-sender gate.
			await seedDefaultSenderIfNeeded(ctx);
			if (!(await isCampaignSenderAllowed(ctx, fromEmail))) {
				throwForbidden(senderNotAllowedMessage(fromEmail));
			}
		}
	}
	if (args.replyTo !== undefined) patch.replyTo = sanitizeEmailHeaderValue(args.replyTo);
	if (args.archiveEnabled !== undefined) patch.archiveEnabled = args.archiveEnabled;
	return patch;
}

/** A segment audience must name a segment that exists. */
export async function assertAudienceTarget(
	ctx: MutationCtx,
	audience: StoredAudience
): Promise<void> {
	if (audience.kind === 'segment') {
		await getOrThrow(ctx, audience.segmentId, 'Segment');
	}
}

/**
 * Validate the linked email and subject. The email must be live (not in
 * Recently deleted); returns the trimmed subject.
 */
export async function campaignContentFields(
	ctx: MutationCtx,
	args: { emailTemplateId: Id<'emailTemplates'>; subject?: string }
): Promise<{ emailTemplateId: Id<'emailTemplates'>; subject: string | undefined }> {
	if (args.subject) validateStringLength(args.subject, STRING_LIMITS.SUBJECT, 'Subject');
	await getLiveOrThrow(ctx, args.emailTemplateId, 'Email template');
	return { emailTemplateId: args.emailTemplateId, subject: args.subject?.trim() };
}

export interface AbTestConfigInput {
	testType: 'subject' | 'content';
	variantBSubject?: string;
	variantBTemplateId?: Id<'emailTemplates'>;
	splitPercentage: number;
	winnerCriteria: 'open_rate' | 'click_rate' | 'manual';
	testDuration?: number;
}

type AbTestConfig = NonNullable<Doc<'campaigns'>['abTestConfig']>;

/** Validate an A/B test setup and build the config the lifecycle stores. */
export async function buildAbTestConfig(
	ctx: MutationCtx,
	args: AbTestConfigInput
): Promise<AbTestConfig> {
	if (args.splitPercentage < 10 || args.splitPercentage > 50) {
		throwInvalidInput('Split percentage must be between 10 and 50');
	}
	if (args.testType === 'subject' && !args.variantBSubject) {
		throwInvalidInput('Variant B subject is required for subject tests');
	}
	if (args.testType === 'content' && !args.variantBTemplateId) {
		throwInvalidInput('Variant B template is required for content tests');
	}
	if (args.testType === 'content' && args.variantBTemplateId) {
		await getLiveOrThrow(ctx, args.variantBTemplateId, 'Variant B template');
	}

	const config: AbTestConfig = {
		testType: args.testType,
		splitPercentage: args.splitPercentage,
		winnerCriteria: args.winnerCriteria,
	};
	if (args.testType === 'subject') {
		config.variantBSubject = args.variantBSubject;
	} else {
		config.variantBTemplateId = args.variantBTemplateId as string;
	}
	if (args.winnerCriteria !== 'manual' && args.testDuration) {
		config.testDuration = args.testDuration;
	}
	return config;
}

/** Whether two stored A/B configs say the same thing (key order aside). */
export function sameAbTestConfig(a: AbTestConfig | undefined, b: AbTestConfig): boolean {
	if (!a) return false;
	const keys = new Set([...Object.keys(a), ...Object.keys(b)]) as Set<keyof AbTestConfig>;
	for (const key of keys) {
		if (a[key] !== b[key]) return false;
	}
	return true;
}
