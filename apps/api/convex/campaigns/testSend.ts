'use node';

import { v } from 'convex/values';
import { authedAction } from '../lib/authedFunctions';
import type { ActionCtx } from '../_generated/server';
import { internal, api } from '../_generated/api';
import type { FunctionArgs } from 'convex/server';
import type { TestSendCommit } from './testSendCommit';
import { composeForSend } from '../delivery/sendComposition';
import { formatFromAddress } from '../lib/emailProviders/domainVerification';
import { senderNotAllowedMessage } from './senders';
import { assertCampaignsEnabledInAction } from './_helpers';
import { isValidEmail } from '../lib/inputGuards';
import {
	throwNotFound,
	throwInvalidInput,
	throwInvalidState,
	throwInternal,
	throwForbidden,
	throwRateLimited,
} from '../_utils/errors';
import { isLive } from '../lib/softDelete';

/**
 * The one commit of a test send (`campaigns/testSendCommit.ts`): the sender
 * gate, the rate limit, the member-inbox check and the queued Sends. Throws
 * the gate's refusal; a missing delivery provider is returned, because the two
 * actions report it differently.
 */
async function queueTestSends(
	ctx: Pick<ActionCtx, 'runMutation'>,
	args: FunctionArgs<typeof internal.campaigns.testSendCommit.commitTestSends>
): Promise<Extract<TestSendCommit, { kind: 'queued' | 'no_provider' }>> {
	const outcome = await ctx.runMutation(internal.campaigns.testSendCommit.commitTestSends, args);
	if (outcome.kind === 'sender_not_allowed') {
		throwForbidden(senderNotAllowedMessage(args.fromEmail));
	}
	if (outcome.kind === 'rate_limited') {
		throwRateLimited(
			'Too many test emails — please wait a moment and try again.',
			outcome.retryAfter
		);
	}
	if (outcome.kind === 'recipient_not_member') {
		throwForbidden(
			`Test emails can only be sent to your organization's own member addresses. "${outcome.email}" is not a member of this organization.`
		);
	}
	return outcome;
}

// Action to send a test email for a campaign
// all-members: sending a test email is the emails:test capability (all members);
// the sending domain must be verified.
export const sendTestEmail = authedAction({
	args: {
		campaignId: v.id('campaigns'),
		testEmail: v.string(),
		language: v.optional(v.string()), // Optional language for preview
	},
	handler: async (
		ctx,
		args
	): Promise<{
		success: boolean;
		id?: string;
		message: string;
		language: string;
	}> => {
		await assertCampaignsEnabledInAction(ctx);

		// Get campaign details
		const campaign = await ctx.runQuery(internal.campaigns.sendQueries.getCampaignForSending, {
			campaignId: args.campaignId,
		});

		if (!isLive(campaign)) {
			throwNotFound('Campaign');
		}

		if (!campaign.emailTemplateId) {
			throwInvalidState('Campaign has no email template');
		}

		if (!campaign.fromEmail) {
			throwInvalidState('Campaign has no from email');
		}

		// Validate sending domain is verified
		const domainStatus = await ctx.runQuery(api.domains.domains.getEmailDomainVerificationStatus, {
			email: campaign.fromEmail,
		});

		if (!domainStatus.verified) {
			throwInvalidState(
				domainStatus.error ||
					`Cannot send test email: domain "${domainStatus.domain}" is not verified. Please verify this domain in Settings > Domains.`
			);
		}

		// Get email template content for specified language (or default)
		const langContent = await ctx.runQuery(
			internal.campaigns.sendQueries.getEmailTemplateForLanguage,
			{
				templateId: campaign.emailTemplateId,
				language: args.language,
			}
		);

		if (!langContent) {
			throwNotFound('Email template');
		}

		if (!langContent.htmlContent) {
			throwInvalidState('Email template has no HTML content. Please save the template first.');
		}

		// Build from address
		const from = formatFromAddress(campaign.fromEmail, campaign.fromName);

		// Subject line (campaign subject overrides template subject, else use language-specific)
		const subject = campaign.subject ?? langContent.subject;

		// Test contact with sample data
		const testContact = {
			email: args.testEmail,
			firstName: 'Test',
			lastName: 'User',
		};

		// Compose subject + body for the test kind (no tracking, no footer).
		const composed = composeForSend({
			kind: 'test',
			template: {
				subject,
				htmlContent: langContent.htmlContent,
				plainTextContent: langContent.plainTextContent,
			},
			sampleContact: testContact,
		});

		// Add test email indicator with language info
		const langSuffix = args.language ? ` (${args.language.toUpperCase()})` : '';
		const testSubject = `[TEST${langSuffix}] ${composed.subject}`;

		// COMMIT. Queue a durable test Send through the normal worker → governed
		// dispatch → completion chain, behind the sender, rate-limit and
		// member-inbox gates. The action reports queue acceptance, not delivery.
		const queued = await queueTestSends(ctx, {
			fromEmail: campaign.fromEmail,
			from,
			replyTo: campaign.replyTo,
			subject: testSubject,
			html: composed.html,
			recipients: [args.testEmail],
		});
		if (queued.kind === 'no_provider') throwInvalidState(queued.message);

		return {
			success: true,
			id: queued.sendIds[0],
			message: `Test email queued for ${args.testEmail}`,
			language: langContent.resolvedLanguage,
		};
	},
});

// Action to send a test email directly from the email editor (works with templates, transactional emails, and blocks)
// all-members: sending a test email is the emails:test capability (all members);
// the sending domain must be verified.
// flag-exempt: the template, block and transactional editors send tests
// through it, and none of them depends on `campaigns`.
export const sendTestEmailFromTemplate = authedAction({
	args: {
		templateId: v.optional(v.id('emailTemplates')), // Optional - not required for transactional emails or blocks
		htmlContent: v.string(),
		subject: v.string(),
		testEmails: v.array(v.string()),
		fromEmail: v.string(),
		fromName: v.optional(v.string()),
		sampleData: v.optional(
			v.object({
				firstName: v.optional(v.string()),
				lastName: v.optional(v.string()),
				email: v.optional(v.string()),
			})
		),
		dataVariables: v.optional(v.record(v.string(), v.string())),
	},
	handler: async (ctx, args) => {
		// Validate test emails
		if (args.testEmails.length === 0) {
			throwInvalidInput('At least one test email address is required');
		}

		if (args.testEmails.length > 5) {
			throwInvalidInput('Maximum 5 test email addresses allowed');
		}

		// Validate email format
		for (const email of args.testEmails) {
			if (!isValidEmail(email)) {
				throwInvalidInput(`Invalid email address: ${email}`);
			}
		}

		// Validate sending domain is verified
		const domainStatus = await ctx.runQuery(api.domains.domains.getEmailDomainVerificationStatus, {
			email: args.fromEmail,
		});

		if (!domainStatus.verified) {
			throwInvalidState(
				domainStatus.error ||
					`Cannot send test email: domain "${domainStatus.domain}" is not verified. Please verify this domain in Settings > Domains.`
			);
		}

		// Build from address
		const from = formatFromAddress(args.fromEmail, args.fromName);

		// Sample contact data for personalization (merge custom data variables)
		const sampleContact = {
			email: args.sampleData?.email || args.testEmails[0] || 'test@example.com',
			firstName: args.sampleData?.firstName || 'Test',
			lastName: args.sampleData?.lastName || 'User',
			...args.dataVariables,
		} as { email: string; firstName: string; lastName: string; [key: string]: unknown };

		// Compose subject + body for the test kind (no tracking, no footer).
		const composed = composeForSend({
			kind: 'test',
			template: { subject: args.subject, htmlContent: args.htmlContent },
			sampleContact,
		});
		const personalizedSubject = `[TEST] ${composed.subject}`;
		const personalizedHtml = composed.html;

		// COMMIT. One queued test Send per recipient, behind the sender,
		// rate-limit and member-inbox gates (a non-member recipient refuses the
		// whole call, so the preview cannot relay to an arbitrary address). All
		// recipients are queued or none is.
		const queued = await queueTestSends(ctx, {
			fromEmail: args.fromEmail,
			from,
			subject: personalizedSubject,
			html: personalizedHtml,
			recipients: args.testEmails,
		});
		if (queued.kind === 'no_provider') {
			throwInternal(
				`Failed to send test emails: ${args.testEmails
					.map((email) => `${email}: ${queued.message}`)
					.join(', ')}`
			);
		}
		const results: Array<{ email: string; success: boolean; error?: string }> = args.testEmails.map(
			(email) => ({ email, success: true })
		);

		return {
			success: true,
			results,
			message: `Test email${results.length > 1 ? 's' : ''} queued for ${args.testEmails.join(', ')}`,
		};
	},
});
