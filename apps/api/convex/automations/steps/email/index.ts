import type { ActionCtx } from '../../../_generated/server';
import { internal } from '../../../_generated/api';
import type { Doc, Id } from '../../../_generated/dataModel';
import { composeForSend } from '../../../delivery/sendComposition';
import { RECIPIENT_BLOCKED_ERROR } from '../../../delivery/enqueue';
import { formatFromAddress } from '../../../lib/emailProviders/domainVerification';
import { getOptional } from '../../../lib/env';
import type { StepExecuteArgs, StepModule, StepOutcome } from '../../types';

export interface EmailStepConfig {
	emailTemplateId: string;
	subjectOverride?: string;
}

export const emailStepModule: StepModule<'email', EmailStepConfig> = {
	kind: 'email',
	parseConfig(raw) {
		if (!raw || typeof raw !== 'object') {
			throw new Error('email step: config must be an object');
		}
		const r = raw as Record<string, unknown>;
		if (typeof r['emailTemplateId'] !== 'string') {
			throw new Error('email step: emailTemplateId must be a string');
		}
		return {
			emailTemplateId: r['emailTemplateId'],
			subjectOverride:
				typeof r['subjectOverride'] === 'string' ? r['subjectOverride'] : undefined,
		};
	},
	async enrichForQuery(ctx, config) {
		if (!config.emailTemplateId) return {};
		const template = await ctx.db.get(config.emailTemplateId as Id<'emailTemplates'>);
		return { emailTemplate: template };
	},
	async execute(ctx: ActionCtx, args: StepExecuteArgs<EmailStepConfig>): Promise<StepOutcome> {
		const { config, contact, automation } = args;

		if (!config.emailTemplateId) {
			return { status: 'failed', error: 'No email template configured' };
		}

		const template = await ctx.runQuery(
			internal.automations.stepExecutorQueries.getEmailTemplateForStep,
			{ templateId: config.emailTemplateId as Id<'emailTemplates'> }
		);

		if (!template) {
			return { status: 'failed', error: 'Email template not found' };
		}
		if (!template.htmlContent) {
			return { status: 'failed', error: 'Email template has no HTML content' };
		}

		const orgSettings = await ctx.runQuery(
			internal.automations.stepExecutorQueries.getInstanceSettings
		);

		if (!orgSettings?.defaultFromEmail) {
			return {
				status: 'failed',
				error: 'Email sender not configured. Please set a default sender email in organization settings.',
			};
		}

		// Email step can only run for contacts with an email address. Contacts
		// that arrived via phone/SMS/WhatsApp/generic have no email and this
		// step is a no-op for them — fail explicitly so the automation log
		// reflects why the dispatch was skipped.
		if (!contact.email) {
			return {
				status: 'failed',
				error: 'Contact has no email address',
			};
		}
		const contactEmail = contact.email;

		const fromEmail = orgSettings.defaultFromEmail;
		const fromName = orgSettings.defaultFromName;
		const subject = config.subjectOverride || template.subject;

		// Compose subject + body for the automation kind (no tracking, no footer).
		// The composer personalizes against the contact (firstName/lastName); the
		// resulting subject + html are already fully substituted and are passed
		// straight to the Send producer below.
		const composed = composeForSend({
			kind: 'automation',
			template: { subject, htmlContent: template.htmlContent },
			contactInfo: {
				email: contactEmail,
				firstName: contact.firstName,
				lastName: contact.lastName,
			},
		});
		const personalizedSubject = composed.subject;
		const personalizedHtml = composed.html;
		const from = formatFromAddress(fromEmail, fromName);

		// Insert a `transactionalSends` Send row (kind='automation') and enqueue
		// it on the transactional pool. Routing the automation send through the
		// shared producer + worker means the Send lifecycle owns the worker
		// outcome — provider health, the sendingReputation denominator, and the
		// blocklist-on-hard-bounce effect now all fire for automation emails,
		// which the old direct-dispatch path silently skipped.
		//
		// Automation email steps are MARKETING mail (drip series, broadcasts), so
		// they must carry a `List-Unsubscribe` header to satisfy Gmail/Yahoo's
		// 2024 bulk-sender rule. The header's HMAC token is Node-only, so we hand
		// the worker `convexSiteUrl` + `contactId` and let it build + merge the
		// RFC 8058 one-click header. The one-click endpoint removes the contact
		// across all topics, so it is valid even though an automation has no
		// single owning topic.
		const convexSiteUrl = getOptional('CONVEX_SITE_URL');
		try {
			const { sendId } = await ctx.runMutation(
				internal.delivery.enqueue.enqueueNonCampaignSend,
				{
					kind: 'automation',
					email: contactEmail,
					contactId: contact._id,
					automationId: automation._id,
					subject: personalizedSubject,
					html: personalizedHtml,
					from,
					...(convexSiteUrl
						? { listUnsubscribe: true, convexSiteUrl }
						: {}),
				},
			);

			// `completed` here means the send was ENQUEUED (a queued Send row
			// exists); the actual provider dispatch + lifecycle transition happen
			// asynchronously on the transactional pool.
			return { status: 'completed', emailSendId: sendId };
		} catch (error) {
			const message = error instanceof Error ? error.message : 'Unknown email error';
			// Suppressed recipient (blocklist hit): a permanent, expected state,
			// not a transient failure. Complete the step as a no-op skip — no Send
			// row was written and the run advances rather than burning retries on a
			// condition that will never clear.
			if (message === RECIPIENT_BLOCKED_ERROR) {
				return { status: 'completed' };
			}
			return { status: 'failed', error: message };
		}
	},
};

export type { Doc };
