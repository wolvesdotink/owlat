/**
 * The admin delivery TEST SEND — the action half of the Settings → Delivery
 * status surface, split out of `delivery/status.ts` (which had grown past the
 * ~500 LOC split guideline in CONVENTIONS.md). Its sibling keeps the read side
 * (`getStatus`, `getProviderFeedbackStatus`, `getTransportSummary`) and the
 * `recordTestResult` writer this action calls once a send is accepted.
 *
 * Everything here exists to answer one question with a real message on the
 * wire: does the configured provider actually accept mail from this instance?
 * The stage model below is the shape of that answer.
 */

import { v } from 'convex/values';
import { authedAction } from '../lib/authedFunctions';
import { internal } from '../_generated/api';
import { getOptional } from '../lib/env';
import { isSendProviderKind } from '../lib/sendProviders/types';
import { isValidEmail } from '../lib/inputGuards';
import { normalizeEmail } from '@owlat/shared';

export type DeliveryTestStageKey =
	| 'provider_configuration'
	| 'recipient_validation'
	| 'sender_resolution'
	| 'provider_acceptance'
	| 'result_recording';

export interface DeliveryTestStage {
	key: DeliveryTestStageKey;
	label: string;
	status: 'passed' | 'failed' | 'not_run';
	detail: string;
}

export interface DeliveryTestResult {
	success: boolean;
	error: string | null;
	provider: string | null;
	providerMessageId: string | null;
	latencyMs: number | null;
	attempts: number | null;
	stages: DeliveryTestStage[];
}

function testStages(): DeliveryTestStage[] {
	return [
		{
			key: 'provider_configuration',
			label: 'Provider configuration',
			status: 'not_run',
			detail: 'Not checked',
		},
		{
			key: 'recipient_validation',
			label: 'Recipient address',
			status: 'not_run',
			detail: 'Not checked',
		},
		{
			key: 'sender_resolution',
			label: 'Sender identity',
			status: 'not_run',
			detail: 'Not checked',
		},
		{
			key: 'provider_acceptance',
			label: 'Provider acceptance',
			status: 'not_run',
			detail: 'Not attempted',
		},
		{
			key: 'result_recording',
			label: 'Readiness record',
			status: 'not_run',
			detail: 'Not attempted',
		},
	];
}

function updateStage(
	stages: DeliveryTestStage[],
	key: DeliveryTestStageKey,
	status: DeliveryTestStage['status'],
	detail: string
): void {
	const stage = stages.find((entry) => entry.key === key);
	if (stage) Object.assign(stage, { status, detail });
}

function testResult(
	stages: DeliveryTestStage[],
	patch: Omit<DeliveryTestResult, 'stages'>
): DeliveryTestResult {
	return { ...patch, stages };
}

/**
 * Send a real test email through the configured delivery provider, so an admin
 * can trace the send path through provider acceptance before trusting it with a
 * campaign or transactional traffic. Reuses the single system transport
 * (`internal.systemMail.sendSystemEmail`) — it routes through whatever
 * transport `EMAIL_PROVIDER` names in the composed send-provider registry,
 * built-in or plugin-contributed; this does NOT add a parallel sender. Records
 * a success timestamp for the status page and onboarding surface.
 *
 * Returns a stage-by-stage trace rather than throwing on an expected provider
 * failure, including the safe provider receipt metadata. Acceptance is not
 * called delivery: the recipient inbox or provider feedback confirms that later.
 */
// authz: admin floor enforced via internal.auth.membership.assertOrgAdmin
// (organization:manage) inside the handler — actions can't call
// requireOrgPermission directly.
export const sendTest = authedAction({
	args: { to: v.string() },
	handler: async (ctx, args): Promise<DeliveryTestResult> => {
		// Admin floor (organization:manage) — actions can't run requireOrgPermission
		// directly, so assert through the internal query that inherits our identity.
		await ctx.runQuery(internal.auth.membership.assertOrgAdmin, {});

		const stages = testStages();
		const provider = getOptional('EMAIL_PROVIDER');
		const providerReady = await ctx.runQuery(
			internal.lib.sendProviders.capability.environmentSendProviderReady,
			{}
		);
		if (!isSendProviderKind(provider) || !providerReady) {
			updateStage(stages, 'provider_configuration', 'failed', 'No usable provider is configured');
			return testResult(stages, {
				success: false,
				error:
					'No delivery provider is configured. Set EMAIL_PROVIDER to a registered transport and configure its requirements, then try again.',
				provider: provider ?? null,
				providerMessageId: null,
				latencyMs: null,
				attempts: null,
			});
		}
		updateStage(stages, 'provider_configuration', 'passed', `${provider} is configured`);

		const to = args.to.trim();
		if (!isValidEmail(to)) {
			updateStage(stages, 'recipient_validation', 'failed', 'Recipient address is invalid');
			return testResult(stages, {
				success: false,
				error: 'Enter a valid recipient address for the test email.',
				provider,
				providerMessageId: null,
				latencyMs: null,
				attempts: null,
			});
		}
		// Restrict the recipient to an org-member inbox + per-user rate limit, so this
		// admin test action can't be looped into an open relay that sprays mail from
		// the instance's verified sending identity to arbitrary external addresses
		// (mirrors campaigns/testSend). Both checks reuse the shared campaign-test
		// gate so the two preview paths can't drift.
		const guard = await ctx.runQuery(
			internal.campaigns.sendQueries.getTestSendAllowedRecipients,
			{}
		);
		const rl = await ctx.runMutation(internal.campaigns.sendQueries.checkTestSendRateLimit, {
			userId: guard.callerUserId,
		});
		if (!rl.ok) {
			updateStage(
				stages,
				'recipient_validation',
				'failed',
				'Too many test emails — wait a moment and try again'
			);
			return testResult(stages, {
				success: false,
				error: 'Too many test emails — please wait a moment and try again.',
				provider,
				providerMessageId: null,
				latencyMs: null,
				attempts: null,
			});
		}
		if (!new Set(guard.allowed).has(normalizeEmail(to))) {
			updateStage(
				stages,
				'recipient_validation',
				'failed',
				'Recipient is not an organization member address'
			);
			return testResult(stages, {
				success: false,
				error:
					"Test emails can only be sent to your organization's own member addresses. Add the recipient as a member, or use their member address.",
				provider,
				providerMessageId: null,
				latencyMs: null,
				attempts: null,
			});
		}
		updateStage(stages, 'recipient_validation', 'passed', 'Recipient address is valid');

		let team: {
			defaultFromEmail: string | null;
			defaultFromName: string | null;
		} | null;
		try {
			team = await ctx.runQuery(internal.confirmationEmailQueries.getTeamInfo, {});
		} catch {
			updateStage(stages, 'sender_resolution', 'failed', 'Could not load the sender identity');
			return testResult(stages, {
				success: false,
				error: 'Could not resolve the sender identity. Check the deployment logs.',
				provider,
				providerMessageId: null,
				latencyMs: null,
				attempts: null,
			});
		}
		const fromEmail =
			team?.defaultFromEmail || `noreply@${getOptional('DEFAULT_FROM_DOMAIN') || 'mail.owlat.app'}`;
		const fromName = team?.defaultFromName || 'Owlat';
		const from = fromName ? `${fromName} <${fromEmail}>` : fromEmail;
		if (!isValidEmail(fromEmail)) {
			updateStage(stages, 'sender_resolution', 'failed', 'Default sender address is invalid');
			return testResult(stages, {
				success: false,
				error: 'The default sender address is invalid. Update the sender identity and try again.',
				provider,
				providerMessageId: null,
				latencyMs: null,
				attempts: null,
			});
		}
		updateStage(stages, 'sender_resolution', 'passed', `Sending as ${fromEmail}`);

		let dispatched: {
			provider: string;
			providerMessageId: string;
			latencyMs: number;
			attempts: number;
		};
		try {
			dispatched = await ctx.runAction(internal.systemMail.sendSystemEmail, {
				to,
				from,
				subject: 'Owlat delivery test',
				html:
					'<p>This is a test email from your Owlat instance.</p>' +
					`<p>If you received it, your delivery provider (<strong>${provider}</strong>) is working.</p>`,
			});
		} catch {
			// Swallow the provider error detail (it can carry endpoint/credential
			// hints) and surface a safe, actionable message instead.
			updateStage(
				stages,
				'provider_acceptance',
				'failed',
				`${provider} did not accept the message`
			);
			return testResult(stages, {
				success: false,
				error: 'Test send failed. Check your provider credentials and the deployment logs.',
				provider,
				providerMessageId: null,
				latencyMs: null,
				attempts: null,
			});
		}
		updateStage(
			stages,
			'provider_acceptance',
			'passed',
			`Accepted as ${dispatched.providerMessageId}`
		);

		try {
			await ctx.runMutation(internal.delivery.status.recordTestResult, { at: Date.now() });
			updateStage(stages, 'result_recording', 'passed', 'Readiness timestamp recorded');
		} catch {
			updateStage(stages, 'result_recording', 'failed', 'Could not record the readiness result');
			return testResult(stages, {
				success: false,
				error: 'The provider accepted the message, but the readiness result could not be recorded.',
				provider: dispatched.provider,
				providerMessageId: dispatched.providerMessageId,
				latencyMs: dispatched.latencyMs,
				attempts: dispatched.attempts,
			});
		}

		return testResult(stages, {
			success: true,
			error: null,
			provider: dispatched.provider,
			providerMessageId: dispatched.providerMessageId,
			latencyMs: dispatched.latencyMs,
			attempts: dispatched.attempts,
		});
	},
});
