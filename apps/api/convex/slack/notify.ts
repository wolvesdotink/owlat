/**
 * Slack approvals reference app — outbound notification (Tier-2 connected app,
 * PP-26). Posts an approval request to the configured Slack incoming-webhook so
 * humans can vote. This is the app's "automation notification" side.
 *
 * The notification is BEST-EFFORT and can only ever ADD work: whether it
 * succeeds, fails, or is skipped, the restrict-only hold stands until a Slack
 * quorum approves. Nothing here releases a hold or sends mail.
 *
 * Hardening:
 *   - SSRF defense: the webhook URL must be https and its host must be Slack's
 *     (`hooks.slack.com`). Anything else is refused before any fetch.
 *   - timeout: the POST is bounded by a deadline; a hung Slack never wedges the
 *     scheduler.
 *   - safe fallback: every failure path records `failed`/`skipped` and returns;
 *     the action never throws, so it cannot break the send pipeline.
 *   - no email content: the message carries only the opaque approval token and a
 *     neutral prompt, so no untrusted inbound text is forwarded to Slack.
 */

import { v } from 'convex/values';
import { internal } from '../_generated/api';
import { internalAction, type ActionCtx } from '../_generated/server';
import { logError } from '../lib/runtimeLog';
import { readSlackApprovalsConfig } from './config';
import { APPROVE_ACTION_ID, REJECT_ACTION_ID } from './payload';

const SLACK_WEBHOOK_HOST = 'hooks.slack.com';
const NOTIFY_TIMEOUT_MS = 8_000;

/** Post the approval request for `approvalToken` to Slack. Never throws. */
export const postApprovalRequest = internalAction({
	args: { approvalToken: v.string() },
	handler: async (ctx, args): Promise<void> => {
		const config = readSlackApprovalsConfig();
		if (!config.active) {
			await recordOutcome(
				ctx,
				args.approvalToken,
				'skipped',
				'Slack approvals app is not configured'
			);
			return;
		}
		if (!isAllowedSlackWebhook(config.webhookUrl)) {
			await recordOutcome(
				ctx,
				args.approvalToken,
				'failed',
				'Webhook URL is not an allowed Slack host'
			);
			return;
		}

		try {
			const response = await fetch(config.webhookUrl, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify(buildMessage(args.approvalToken)),
				signal: AbortSignal.timeout(NOTIFY_TIMEOUT_MS),
			});
			if (!response.ok) {
				await recordOutcome(
					ctx,
					args.approvalToken,
					'failed',
					`Slack responded ${response.status}`
				);
				return;
			}
			await recordOutcome(ctx, args.approvalToken, 'sent');
		} catch (error) {
			// Timeout / network error: hold stands, humans simply were not asked.
			logError('slack.notify.postApprovalRequest', error);
			await recordOutcome(ctx, args.approvalToken, 'failed', 'Slack notification request failed');
		}
	},
});

/**
 * True only for an https URL whose host is exactly Slack's incoming-webhook
 * host. Rejects userinfo, IP literals, and any other host — closing the SSRF
 * vector where a misconfigured URL points the POST at an internal address.
 */
export function isAllowedSlackWebhook(rawUrl: string): boolean {
	let url: URL;
	try {
		url = new URL(rawUrl);
	} catch {
		return false;
	}
	if (url.protocol !== 'https:') return false;
	if (url.username !== '' || url.password !== '') return false;
	return url.hostname === SLACK_WEBHOOK_HOST;
}

function buildMessage(approvalToken: string): Record<string, unknown> {
	return {
		text: 'Owlat is holding an autonomous reply for approval.',
		blocks: [
			{
				type: 'section',
				text: {
					type: 'mrkdwn',
					text: 'An autonomous reply is *held* pending approval. Approve to release the Slack hold (Owlat still runs every other safety gate); reject to keep it held for human review.',
				},
			},
			{
				type: 'actions',
				elements: [
					{
						type: 'button',
						style: 'primary',
						text: { type: 'plain_text', text: 'Approve' },
						action_id: APPROVE_ACTION_ID,
						value: approvalToken,
					},
					{
						type: 'button',
						style: 'danger',
						text: { type: 'plain_text', text: 'Reject' },
						action_id: REJECT_ACTION_ID,
						value: approvalToken,
					},
				],
			},
		],
	};
}

async function recordOutcome(
	ctx: ActionCtx,
	approvalToken: string,
	outcome: 'sent' | 'failed' | 'skipped',
	error?: string
): Promise<void> {
	await ctx
		.runMutation(internal.slack.approvals.setNotifyOutcome, {
			approvalToken,
			outcome,
			...(error ? { error } : {}),
		})
		.catch((recordError) => logError('slack.notify.recordOutcome', recordError));
}
