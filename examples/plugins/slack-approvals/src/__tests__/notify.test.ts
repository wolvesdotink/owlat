import { describe, expect, it } from 'vitest';
import { createApprovalRequest, type ApprovalRequest } from '../approvalStore';
import { buildApprovalMessage, createSlackNotifier, type SlackMessage } from '../notify';
import { SLACK_APPROVE_ACTION_ID, SLACK_REJECT_ACTION_ID } from '../slackCallback';

const request: ApprovalRequest = createApprovalRequest({
	id: 'm-42',
	organizationId: 'org-a',
	requiredApprovals: 2,
	createdAtMs: 1_700_000_000_000,
	ttlMs: 60_000,
});

function findButtons(message: SlackMessage): Array<Record<string, unknown>> {
	const actions = message.blocks.find(
		(block): block is { type: string; elements: Array<Record<string, unknown>> } =>
			typeof block === 'object' && block !== null && (block as { type?: string }).type === 'actions'
	);
	return actions?.elements ?? [];
}

describe('buildApprovalMessage', () => {
	it('carries approve/reject buttons keyed to the request id', () => {
		const message = buildApprovalMessage(request, { subject: 'Hello' }, { channel: 'C1' });
		expect(message.channel).toBe('C1');
		const buttons = findButtons(message);
		expect(buttons).toHaveLength(2);
		expect(buttons[0]).toMatchObject({ action_id: SLACK_APPROVE_ACTION_ID, value: 'm-42' });
		expect(buttons[1]).toMatchObject({ action_id: SLACK_REJECT_ACTION_ID, value: 'm-42' });
	});

	it('clamps an oversized subject so a pathological draft cannot bloat the message', () => {
		const huge = 'x'.repeat(5_000);
		const message = buildApprovalMessage(
			request,
			{ subject: huge },
			{ channel: 'C1', maxSubjectCodePoints: 50 }
		);
		const serialized = JSON.stringify(message);
		expect(serialized).toContain('…');
		expect(serialized.length).toBeLessThan(1_000);
	});

	it('renders draft text only in plain_text fields (never interactive mrkdwn)', () => {
		const message = buildApprovalMessage(
			request,
			{ subject: '*click me* <http://evil|link>' },
			{ channel: 'C1' }
		);
		for (const block of message.blocks) {
			const text = (block as { text?: { type?: string } }).text;
			if (text) expect(text.type).toBe('plain_text');
		}
	});
});

describe('createSlackNotifier', () => {
	it('posts the built message through the injected transport', async () => {
		const sent: SlackMessage[] = [];
		const notifier = createSlackNotifier({
			channel: 'C9',
			postMessage: async (message) => {
				sent.push(message);
			},
		});
		await notifier.postApprovalRequest(request, { subject: 'Re: hi' });
		expect(sent).toHaveLength(1);
		expect(sent[0]!.channel).toBe('C9');
	});
});
