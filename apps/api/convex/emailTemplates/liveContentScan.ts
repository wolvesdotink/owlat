/**
 * Content scans for marketing templates that are already going out.
 *
 * A campaign is scanned once, when its send is prepared (`campaigns/send.ts`),
 * and its walker then reads the template's live HTML for every page it
 * enqueues (`campaigns/sendQueries.ts` `getEmailTemplateForLanguage`). An
 * automation is scanned when it is switched on (`automations/lifecycle.ts`),
 * and every email step run then reads the template's live HTML
 * (`automations/steps/email`). So a write that changes the HTML of a template
 * a sending campaign or an active automation uses reaches recipients
 * unscanned unless the write is scanned. The writers call
 * {@link scanLiveTemplateWrite} after their patch; a refusal throws, so the
 * whole write rolls back.
 *
 * Neither campaign nor automation has a review step at this point, so a
 * verdict that would have held the start for review (suspicious) refuses the
 * write too. A template nothing is sending takes any content an editor saves:
 * the start or the activation that sends it scans it then.
 */

import type { MutationCtx } from '../_generated/server';
import type { Doc, Id } from '../_generated/dataModel';
import { scanContent, type ContentScanResult } from '@owlat/email-scanner';
import { scanPublishableVariants } from '../transactional/lifecycleReducer';
import { resolveVariantBSource } from '../campaigns/sendPlanning';
import { throwInvalidState } from '../_utils/errors';

// bounded: `sending` is a transient state; a deployment runs a handful at once.
const SENDING_CAMPAIGN_SCAN = 200;

// bounded: the steps that reference one template. A full page refuses the
// write, so a step past the cap is never sent unscanned.
const TEMPLATE_STEP_SCAN = 500;

const LEVEL_RANK = { clean: 0, suspicious: 1, blocked: 2 } as const;

/** The worse of two scans; null stands for "nothing flagged yet". */
function worse(
	current: ContentScanResult | null,
	next: ContentScanResult
): ContentScanResult | null {
	if (next.level === 'clean') return current;
	if (!current) return next;
	const rank = LEVEL_RANK[next.level] - LEVEL_RANK[current.level];
	return rank > 0 || (rank === 0 && next.score > current.score) ? next : current;
}

/**
 * The worst scan of what campaigns sending right now send from this template,
 * or null when every one scans clean. A campaign's subject override replaces
 * the subject of every language of its main template (`pageDecision.ts`
 * `bucketContent`); a content test's variant B template sends its own subject.
 */
async function scanForSendingCampaigns(
	ctx: MutationCtx,
	template: Doc<'emailTemplates'>,
	htmlContent: string
): Promise<ContentScanResult | null> {
	const sending = await ctx.db
		.query('campaigns')
		.withIndex('by_deleted_at_and_status_and_updated_at', (q) =>
			q.eq('deletedAt', undefined).eq('status', 'sending')
		)
		.take(SENDING_CAMPAIGN_SCAN);
	let worst: ContentScanResult | null = null;
	for (const campaign of sending) {
		const asMain = campaign.emailTemplateId === template._id;
		const variantB = resolveVariantBSource(campaign);
		const asVariantB = variantB.templateId === template._id;
		if (asMain) {
			worst = worse(
				worst,
				scanPublishableVariants(
					template.subject,
					htmlContent,
					template.htmlTranslations,
					campaign.subject
				)
			);
			// A subject test sends the same HTML under variant B's subject.
			if (variantB.subject !== undefined) {
				worst = worse(
					worst,
					scanPublishableVariants(
						template.subject,
						htmlContent,
						template.htmlTranslations,
						variantB.subject
					)
				);
			}
		}
		if (asVariantB) {
			worst = worse(
				worst,
				scanPublishableVariants(template.subject, htmlContent, template.htmlTranslations)
			);
		}
	}
	return worst;
}

/** The template an email step sends, or undefined for any other step. */
function emailStepTemplateId(step: Doc<'automationSteps'>): string | undefined {
	if (step.stepType !== 'email') return undefined;
	const config = step.config as { emailTemplateId?: unknown } | undefined;
	return typeof config?.emailTemplateId === 'string' ? config.emailTemplateId : undefined;
}

function emailStepSubjectOverride(step: Doc<'automationSteps'>): string | undefined {
	const config = step.config as { subjectOverride?: unknown } | undefined;
	return typeof config?.subjectOverride === 'string' && config.subjectOverride
		? config.subjectOverride
		: undefined;
}

/**
 * What an automation email step sends: the step's subject (the template's
 * unless the step overrides it) with the default-language HTML. The step never
 * sends a translation.
 */
function scanEmailStep(step: Doc<'automationSteps'>, template: Doc<'emailTemplates'>) {
	return scanContent(
		emailStepSubjectOverride(step) ?? template.subject,
		template.htmlContent ?? ''
	);
}

/**
 * The worst scan of this template across the email steps of active
 * automations that send it, or null when every one scans clean.
 */
async function scanForActiveAutomations(
	ctx: MutationCtx,
	template: Doc<'emailTemplates'>
): Promise<ContentScanResult | null> {
	const steps = await ctx.db
		.query('automationSteps')
		.withIndex('by_email_template', (q) => q.eq('config.emailTemplateId', template._id))
		.take(TEMPLATE_STEP_SCAN);
	if (steps.length === TEMPLATE_STEP_SCAN) {
		throwInvalidState(
			`More than ${TEMPLATE_STEP_SCAN - 1} automation steps use this template, too many to scan this save against. ` +
				'Point some of them at a copy of the template, then save again.'
		);
	}
	let worst: ContentScanResult | null = null;
	for (const step of steps) {
		// A step retyped away from email keeps its old config, and sends nothing.
		if (step.stepType !== 'email') continue;
		const automation = await ctx.db.get(step.automationId);
		if (automation?.status !== 'active' || automation.deletedAt !== undefined) continue;
		worst = worse(worst, scanEmailStep(step, template));
	}
	return worst;
}

function issuesOf(scan: Pick<ContentScanResult, 'flags'>): string {
	return scan.flags.map((flag) => flag.description).join('; ');
}

function refuse(scan: ContentScanResult, usedBy: string, tail: string): never {
	const verdict = scan.level === 'blocked' ? 'Content blocked' : 'Content flagged';
	throwInvalidState(
		`${verdict} by our content scanner (score: ${scan.score}/100) on a template ${usedBy}. ` +
			`Issues: ${issuesOf(scan)}. ${tail}`,
		{ scanScore: scan.score }
	);
}

/** Which write changed the template's HTML. */
export type LiveTemplateWrite = 'editor' | 'rerender';

/**
 * Scan a marketing template after a write changed its HTML, and throw when
 * the content must not reach a send that is already going out (see the module
 * comment). A saved-block re-render also never lands blocked content on any
 * template: nobody is at the editor to see the verdict, and the next send
 * would only refuse it later.
 */
export async function scanLiveTemplateWrite(
	ctx: MutationCtx,
	templateId: Id<'emailTemplates'>,
	write: LiveTemplateWrite
): Promise<void> {
	const template = await ctx.db.get(templateId);
	if (!template?.htmlContent) return;
	const tail =
		write === 'rerender'
			? 'The template keeps its previous HTML; review the saved block, then save the template again.'
			: 'The template was not saved; edit the flagged content and save again.';
	if (write === 'rerender') {
		const own = scanPublishableVariants(
			template.subject,
			template.htmlContent,
			template.htmlTranslations
		);
		if (own.level === 'blocked') {
			throwInvalidState(
				`Content blocked by our content scanner (score: ${own.score}/100). Issues: ${issuesOf(own)}. ` +
					'The template keeps its previous HTML.',
				{ scanScore: own.score }
			);
		}
	}
	// Each live use is scanned with the subject it sends, which can differ from
	// the template's, so a clean verdict on the template alone settles nothing.
	const campaignScan = await scanForSendingCampaigns(ctx, template, template.htmlContent);
	if (campaignScan) refuse(campaignScan, 'a sending campaign uses', tail);
	const automationScan = await scanForActiveAutomations(ctx, template);
	if (automationScan) refuse(automationScan, 'an active automation sends', tail);
}

/**
 * The refusal for switching an automation on, or null when every email step's
 * content scans clean. An automation has no review step, so a suspicious
 * verdict refuses activation as a blocked one does; a campaign start would
 * have held it for a platform admin. A step whose template is gone or empty is
 * left to the step run, which fails it with that reason.
 */
export async function automationActivationScanRefusal(
	ctx: MutationCtx,
	steps: ReadonlyArray<Doc<'automationSteps'>>
): Promise<string | null> {
	for (const step of steps) {
		const templateId = emailStepTemplateId(step);
		if (!templateId) continue;
		const normalized = ctx.db.normalizeId('emailTemplates', templateId);
		const template = normalized ? await ctx.db.get(normalized) : null;
		// A template in Recently deleted is scanned too: restoring it brings its
		// content back to this step without a write that would scan it.
		if (!template?.htmlContent) continue;
		const scan = scanEmailStep(step, template);
		if (scan.level === 'clean') continue;
		const verdict = scan.level === 'blocked' ? 'Content blocked' : 'Content flagged';
		return (
			`${verdict} by our content scanner (score: ${scan.score}/100) in the email "${template.name}". ` +
			`Issues: ${issuesOf(scan)}. An automation sends without review, so edit the email, then activate again.`
		);
	}
	return null;
}
