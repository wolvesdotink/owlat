'use node';

import { v } from 'convex/values';
import { authedAction } from '../lib/authedFunctions';
import type { ActionCtx } from '../_generated/server';
import { internal, api } from '../_generated/api';
import { sendProviderDispatch } from '../lib/sendProviders/dispatch';
import { composeForSend } from '../delivery/sendComposition';
import { formatFromAddress } from '../lib/emailProviders/domainVerification';
import { senderNotAllowedMessage } from './senders';
import { isValidEmail } from '../lib/inputGuards';
import { normalizeEmail } from '@owlat/shared';
import {
	throwNotFound,
	throwInvalidInput,
	throwInvalidState,
	throwInternal,
	throwForbidden,
	throwRateLimited,
} from '../_utils/errors';

/**
 * Guard the test/preview send actions: per-user rate limit + restrict
 * recipients to the org's own member inboxes. Test sends emit real, unscanned,
 * caller-controllable HTML from the verified sending domain, so a member could
 * otherwise relay phishing to arbitrary external addresses. Throws on violation.
 */
async function guardTestSend(
	ctx: Pick<ActionCtx, 'runQuery' | 'runMutation'>,
	recipients: string[]
): Promise<void> {
	const { allowed, callerUserId } = await ctx.runQuery(
		internal.campaigns.sendQueries.getTestSendAllowedRecipients,
		{}
	);
	const rl = await ctx.runMutation(internal.campaigns.sendQueries.checkTestSendRateLimit, {
		userId: callerUserId,
	});
	if (!rl.ok) {
		throwRateLimited('Too many test emails — please wait a moment and try again.', rl.retryAfter);
	}
	const allowedSet = new Set(allowed);
	for (const email of recipients) {
		if (!allowedSet.has(normalizeEmail(email))) {
			throwForbidden(
				`Test emails can only be sent to your organization's own member addresses. "${email}" is not a member of this organization.`
			);
		}
	}
}

/**
 * Curated-sender gate for the test/preview actions (2026-07-10 plan, decision
 * 8): a test send uses the same from-address a real send would, so hold it to
 * the same list/toggle rule the campaign pre-flight enforces. The dedicated
 * verified-domain check each caller runs first stays the floor. Throws
 * `forbidden` with the shared `senderNotAllowedMessage` copy on violation.
 */
async function assertCampaignSenderAllowed(
	ctx: Pick<ActionCtx, 'runQuery' | 'runMutation'>,
	fromEmail: string
): Promise<void> {
	// Self-heal the common post-upgrade case (empty curated list, toggle OFF, no
	// management UI until d2/d3) before gating: seed the org default sender so a
	// test send from the org's own default address keeps working. Idempotent — a
	// no-op read once any sender exists.
	await ctx.runMutation(internal.campaigns.senders.seedDefaultSender, {});
	const allowed = await ctx.runQuery(internal.campaigns.senders.checkSenderAllowed, { fromEmail });
	if (!allowed) {
		throwForbidden(senderNotAllowedMessage(fromEmail));
	}
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
		// Get campaign details
		const campaign = await ctx.runQuery(internal.campaigns.sendQueries.getCampaignForSending, {
			campaignId: args.campaignId,
		});

		if (!campaign) {
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

		await assertCampaignSenderAllowed(ctx, campaign.fromEmail);

		// Rate-limit + restrict the recipient to an org-member inbox so the
		// preview action can't be used to relay mail to arbitrary addresses.
		await guardTestSend(ctx, [args.testEmail]);

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
			template: { subject, htmlContent: langContent.htmlContent },
			sampleContact: testContact,
		});

		// Add test email indicator with language info
		const langSuffix = args.language ? ` (${args.language.toUpperCase()})` : '';
		const testSubject = `[TEST${langSuffix}] ${composed.subject}`;

		// Send the test email through the Send dispatch helper. Test sends
		// previously bypassed the workpool → Send completion → health chain;
		// routing through the helper closes that drift.
		const resolved = await ctx.runQuery(internal.lib.sendProviders.route.resolveSendRoute, {
			messageType: 'transactional',
			to: args.testEmail,
			from,
		});
		if (!resolved) {
			throwInternal('Cannot send test email: no delivery provider is configured.');
		}
		const dispatched = await sendProviderDispatch(ctx, resolved.providerType, {
			to: args.testEmail,
			from,
			replyTo: campaign.replyTo,
			subject: testSubject,
			html: composed.html,
		});

		if (!dispatched.result.success) {
			throwInternal(`Failed to send test email: ${dispatched.result.errorMessage}`);
		}

		return {
			success: true,
			id: dispatched.result.id,
			message: `Test email sent to ${args.testEmail}`,
			language: langContent.resolvedLanguage,
		};
	},
});

// Action to send a test email directly from the email editor (works with templates, transactional emails, and blocks)
// all-members: sending a test email is the emails:test capability (all members);
// the sending domain must be verified.
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

		// Rate-limit + restrict recipients to org-member inboxes so the preview
		// action can't relay attacker-controlled HTML to arbitrary external
		// addresses from the verified sending domain.
		await guardTestSend(ctx, args.testEmails);

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

		await assertCampaignSenderAllowed(ctx, args.fromEmail);

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

		// Send to all test recipients via the dispatch helper (uniform
		// retry + health recording per attempt).
		const results: Array<{ email: string; success: boolean; error?: string }> = [];

		for (const testEmail of args.testEmails) {
			try {
				const resolved = await ctx.runQuery(internal.lib.sendProviders.route.resolveSendRoute, {
					messageType: 'transactional',
					to: testEmail,
					from,
				});
				if (!resolved) {
					throw new Error('No delivery provider is configured');
				}
				const dispatched = await sendProviderDispatch(ctx, resolved.providerType, {
					to: testEmail,
					from,
					subject: personalizedSubject,
					html: personalizedHtml,
				});

				if (!dispatched.result.success) {
					results.push({
						email: testEmail,
						success: false,
						error: dispatched.result.errorMessage,
					});
				} else {
					results.push({
						email: testEmail,
						success: true,
					});
				}
			} catch (error) {
				results.push({
					email: testEmail,
					success: false,
					error: error instanceof Error ? error.message : 'Unknown error',
				});
			}
		}

		const successCount = results.filter((r) => r.success).length;
		const failedCount = results.filter((r) => !r.success).length;

		if (failedCount > 0 && successCount === 0) {
			throwInternal(
				`Failed to send test emails: ${results
					.filter((r) => !r.success)
					.map((r) => `${r.email}: ${r.error}`)
					.join(', ')}`
			);
		}

		return {
			success: true,
			results,
			message:
				failedCount > 0
					? `Sent ${successCount} test email(s), ${failedCount} failed`
					: `Test email${successCount > 1 ? 's' : ''} sent to ${args.testEmails.join(', ')}`,
		};
	},
});
