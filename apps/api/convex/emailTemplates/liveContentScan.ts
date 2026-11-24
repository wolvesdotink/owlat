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

// bounded: read only after a scan came back non-clean. A full page is treated
// as "may be in use", so an automation past the cap is never sent unscanned.
const ACTIVE_AUTOMATION_SCAN = 200;

/** Whether a campaign that is sending right now reads this template's HTML. */
async function isSendingCampaignTemplate(
	ctx: MutationCtx,
	templateId: Id<'emailTemplates'>
): Promise<boolean> {
	const sending = await ctx.db
		.query('campaigns')
		.withIndex('by_deleted_at_and_status_and_updated_at', (q) =>
			q.eq('deletedAt', undefined).eq('status', 'sending')
		)
		.take(SENDING_CAMPAIGN_SCAN);
	return sending.some(
		(campaign) =>
			campaign.emailTemplateId === templateId ||
			resolveVariantBSource(campaign).templateId === templateId
	);
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
 * automations that send it, or null when none does.
 */
async function scanForActiveAutomations(
	ctx: MutationCtx,
	template: Doc<'emailTemplates'>
): Promise<ContentScanResult | null> {
	const active = await ctx.db
		.query('automations')
		.withIndex('by_deleted_at_and_status', (q) =>
			q.eq('deletedAt', undefined).eq('status', 'active')
		)
		.take(ACTIVE_AUTOMATION_SCAN);
	let worst: ContentScanResult | null = null;
	for (const automation of active) {
		const steps = await ctx.db
			.query('automationSteps')
			.withIndex('by_automation', (q) => q.eq('automationId', automation._id))
			.collect(); // bounded: one automation's steps
		for (const step of steps) {
			if (emailStepTemplateId(step) !== template._id) continue;
			const scan = scanEmailStep(step, template);
			if (scan.level !== 'clean' && (!worst || scan.score > worst.score)) worst = scan;
		}
	}
	if (!worst && active.length === ACTIVE_AUTOMATION_SCAN) {
		return scanContent(template.subject, template.htmlContent ?? '');
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
	const scan = scanPublishableVariants(
		template.subject,
		template.htmlContent,
		template.htmlTranslations
	);
	if (scan.level === 'clean') return;
	const tail =
		write === 'rerender'
			? 'The template keeps its previous HTML; review the saved block, then save the template again.'
			: 'The template was not saved; edit the flagged content and save again.';
	if (scan.level === 'blocked' && write === 'rerender') {
		throwInvalidState(
			`Content blocked by our content scanner (score: ${scan.score}/100). Issues: ${issuesOf(scan)}. ` +
				'The template keeps its previous HTML.',
			{ scanScore: scan.score }
		);
	}
	if (await isSendingCampaignTemplate(ctx, templateId)) {
		refuse(scan, 'a sending campaign uses', tail);
	}
	const automationScan = await scanForActiveAutomations(ctx, template);
	if (automationScan && automationScan.level !== 'clean') {
		refuse(automationScan, 'an active automation sends', tail);
	}
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
		if (!template || template.deletedAt !== undefined || !template.htmlContent) continue;
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
