import type { ActionCtx } from '../../../_generated/server';
import { internal } from '../../../_generated/api';
import type { Doc, Id } from '../../../_generated/dataModel';
import { composeForSend } from '../../../delivery/sendComposition';
import type {
	NonCampaignIntakeOutcome,
	NonCampaignIntakeRejectionReason,
} from '../../../delivery/nonCampaignIntake';
import { formatFromAddress } from '../../../lib/emailProviders/domainVerification';
import { getOptional } from '../../../lib/env';
import type { StepExecuteArgs, StepModule, StepOutcome } from '../../types';

export interface EmailStepConfig {
	emailTemplateId: string;
	subjectOverride?: string;
}

/**
 * How each typed intake refusal becomes a step outcome.
 *
 * TOTAL BY CONSTRUCTION — the `Record<NonCampaignIntakeRejectionReason, …>`
 * makes a new rejection reason a compile error here. It replaces a
 * `message === RECIPIENT_BLOCKED_ERROR` string comparison against a magic
 * constant exported from the enqueue module, where an unrecognised refusal
 * silently fell through to the generic failure branch.
 *
 * The split is per-recipient vs deployment-wide:
 *   - `recipient_blocked` is about THIS contact and will never clear by
 *     retrying, so the step COMPLETES as a no-op skip: no Send row was
 *     written, the run advances, and nothing is retried.
 *   - `no_delivery_provider` and `abuse_blocked` are about the deployment.
 *     They FAIL the step, which is what makes them visible to the operator who
 *     has to fix them — and, for a suspended instance, halting the automation
 *     is the correct response rather than a silent skip. The walker's bounded
 *     backoff (`MAX_RETRY_ATTEMPTS`, then cancel the run) applies as it does to
 *     any other step failure; neither reason spins beyond it.
 */
const REJECTION_STEP_OUTCOME: Record<
	NonCampaignIntakeRejectionReason,
	(detail: string | undefined) => StepOutcome
> = {
	recipient_blocked: () => ({ status: 'completed' }),
	no_delivery_provider: (detail) => ({
		status: 'failed',
		error: detail ?? 'No delivery provider configured',
	}),
	abuse_blocked: () => ({
		status: 'failed',
		error: 'Sending is disabled while this instance is suspended.',
	}),
};

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
			subjectOverride: typeof r['subjectOverride'] === 'string' ? r['subjectOverride'] : undefined,
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
				error:
					'Email sender not configured. Please set a default sender email in organization settings.',
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
			template: {
				subject,
				htmlContent: template.htmlContent,
				plainTextContent: template.plainTextContent,
			},
			contactInfo: {
				email: contactEmail,
				firstName: contact.firstName,
				lastName: contact.lastName,
			},
		});
		const personalizedSubject = composed.subject;
		const personalizedHtml = composed.html;
		const from = formatFromAddress(fromEmail, fromName);

		// Hand the send to the Non-campaign send intake (module): it runs the
		// shared gate sequence (abuse → provider-ready → suppression), resolves
		// the provider route in its own transaction, inserts the
		// `transactionalSends` row (kind='automation') and enqueues it on the
		// transactional pool. Routing the automation send through that intake +
		// the worker means the Send lifecycle owns the worker outcome — provider
		// health, the sendingReputation denominator, and the
		// blocklist-on-hard-bounce effect now all fire for automation emails,
		// which the old direct-dispatch path silently skipped.
		//
		// NO route resolution here any more. This step used to run
		// `resolveSendRoute` first and pass `providerType`/`ipPool` down, which
		// resolved the same message twice — once from an action that could not see
		// the row it was about — for a value the worker treats as a fallback. The
		// intake resolves it in the same transaction as the insert instead. This
		// step needs no route of its own: nothing above the intake reads one.
		//
		// Automation email steps are MARKETING mail (drip series, broadcasts), so
		// they must carry a `List-Unsubscribe` header to satisfy Gmail/Yahoo's
		// 2024 bulk-sender rule. The header's HMAC token is Node-only, so we hand
		// the worker `convexSiteUrl` + `contactId` and let it build + merge the
		// RFC 8058 one-click header. The one-click endpoint removes the contact
		// across all topics, so it is valid even though an automation has no
		// single owning topic.
		const convexSiteUrl = getOptional('CONVEX_SITE_URL');
		let outcome: NonCampaignIntakeOutcome;
		try {
			outcome = await ctx.runMutation(internal.delivery.nonCampaignIntake.intake, {
				kind: 'automation',
				email: contactEmail,
				contactId: contact._id,
				automationId: automation._id,
				subject: personalizedSubject,
				html: personalizedHtml,
				from,
				...(convexSiteUrl ? { listUnsubscribe: true, convexSiteUrl } : {}),
			});
		} catch (error) {
			// Every REFUSAL is now a typed `{ ok: false }` return, so anything that
			// still throws is an infrastructure fault (an OCC conflict, a transient
			// routing deferral crossing the mutation boundary) — never a policy
			// decision. Nothing is classified by matching the message any more.
			return {
				status: 'failed',
				error: error instanceof Error ? error.message : 'Unknown email error',
			};
		}

		if (!outcome.ok) return REJECTION_STEP_OUTCOME[outcome.reason](outcome.detail);

		// `completed` here means the send was ENQUEUED (a queued Send row
		// exists); the actual provider dispatch + lifecycle transition happen
		// asynchronously on the transactional pool.
		return { status: 'completed', emailSendId: outcome.sendId };
	},
};

export type { Doc };
