/**
 * Automation notifications: when a hold opens, post the pending draft to a Slack
 * channel with Approve / Reject buttons. This is the "post to a channel and hold
 * until 👍" half of the reference — the buttons carry the `action_id`s and the
 * request id the callback endpoint expects back.
 *
 * The Slack transport is injected, so message construction is a pure, asserted
 * function and no test touches the network. Draft-derived text is CLAMPED before
 * it enters the message: Owlat has already scrubbed the draft, but a connected
 * app still bounds what it forwards so a pathological subject can't build a giant
 * Slack payload.
 */

import type { ApprovalRequest } from './approvalStore';
import { SLACK_APPROVE_ACTION_ID, SLACK_REJECT_ACTION_ID } from './slackCallback';

/** What the gate calls when a hold opens. */
export interface ApprovalNotifier {
	postApprovalRequest(request: ApprovalRequest, payload: unknown): Promise<void>;
}

/** The Slack `chat.postMessage` body this app emits (the subset it uses). */
export interface SlackMessage {
	readonly channel: string;
	readonly text: string;
	readonly blocks: readonly unknown[];
}

/** Injected Slack sender — a thin seam over `chat.postMessage`. */
export type SlackPostMessage = (message: SlackMessage) => Promise<void>;

export interface SlackNotifierConfig {
	readonly channel: string;
	readonly postMessage: SlackPostMessage;
	/** Max code points of draft-derived text forwarded into the message. */
	readonly maxSubjectCodePoints?: number;
}

const DEFAULT_MAX_SUBJECT_CODE_POINTS = 200;

function clampCodePoints(value: string, maximum: number): string {
	const points = Array.from(value);
	return points.length <= maximum ? value : `${points.slice(0, maximum).join('')}…`;
}

function readOwnString(value: unknown, key: string): string | undefined {
	if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined;
	const descriptor = Object.getOwnPropertyDescriptor(value, key);
	if (!descriptor || !descriptor.enumerable || !('value' in descriptor)) return undefined;
	return typeof descriptor.value === 'string' ? descriptor.value : undefined;
}

/**
 * Build the Slack message for a held draft. The Approve / Reject buttons encode
 * the vote (`action_id`) and the request id (`value`) the callback endpoint
 * reads back, so the loop closes without any server-side session. Draft text is
 * clamped and carried only in `plain_text` fields (never interpolated into
 * mrkdwn), so it renders as text and cannot forge interactive elements.
 */
export function buildApprovalMessage(
	request: ApprovalRequest,
	payload: unknown,
	config: { readonly channel: string; readonly maxSubjectCodePoints?: number }
): SlackMessage {
	const max = config.maxSubjectCodePoints ?? DEFAULT_MAX_SUBJECT_CODE_POINTS;
	const subject = clampCodePoints(readOwnString(payload, 'subject') ?? '(no subject)', max);
	const summary = `Approval needed before auto-sending a reply (${request.requiredApprovals} approval(s) required).`;
	return {
		channel: config.channel,
		text: summary,
		blocks: [
			{ type: 'section', text: { type: 'plain_text', text: summary } },
			{ type: 'section', text: { type: 'plain_text', text: `Subject: ${subject}` } },
			{
				type: 'actions',
				elements: [
					{
						type: 'button',
						action_id: SLACK_APPROVE_ACTION_ID,
						value: request.id,
						text: { type: 'plain_text', text: 'Approve' },
						style: 'primary',
					},
					{
						type: 'button',
						action_id: SLACK_REJECT_ACTION_ID,
						value: request.id,
						text: { type: 'plain_text', text: 'Reject' },
						style: 'danger',
					},
				],
			},
		],
	};
}

/** A {@link ApprovalNotifier} that posts through the injected Slack sender. */
export function createSlackNotifier(config: SlackNotifierConfig): ApprovalNotifier {
	return {
		async postApprovalRequest(request, payload) {
			await config.postMessage(
				buildApprovalMessage(request, payload, {
					channel: config.channel,
					...(config.maxSubjectCodePoints === undefined
						? {}
						: { maxSubjectCodePoints: config.maxSubjectCodePoints }),
				})
			);
		},
	};
}
