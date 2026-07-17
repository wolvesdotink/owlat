import { describe, expect, it } from 'vitest';
import { APPROVE_ACTION_ID, REJECT_ACTION_ID, parseSlackApprovalCallback } from '../payload';

function formBody(payload: unknown): string {
	const params = new URLSearchParams();
	params.set('payload', JSON.stringify(payload));
	return params.toString();
}

function interaction(actionId: string, value: unknown, userId: unknown = 'U123'): unknown {
	return {
		type: 'block_actions',
		user: { id: userId },
		actions: [{ type: 'button', action_id: actionId, value }],
	};
}

describe('parseSlackApprovalCallback — valid interactions', () => {
	it('parses an approve click', () => {
		const result = parseSlackApprovalCallback(formBody(interaction(APPROVE_ACTION_ID, 'tok-1')));
		expect(result).toEqual({ approvalToken: 'tok-1', slackUserId: 'U123', decision: 'approve' });
	});

	it('parses a reject click', () => {
		const result = parseSlackApprovalCallback(formBody(interaction(REJECT_ACTION_ID, 'tok-9')));
		expect(result).toEqual({ approvalToken: 'tok-9', slackUserId: 'U123', decision: 'reject' });
	});

	it('ignores unrelated actions and picks the first Owlat action', () => {
		const body = formBody({
			user: { id: 'U1' },
			actions: [
				{ action_id: 'some_other_button', value: 'x' },
				{ action_id: APPROVE_ACTION_ID, value: 'tok-2' },
			],
		});
		expect(parseSlackApprovalCallback(body)).toEqual({
			approvalToken: 'tok-2',
			slackUserId: 'U1',
			decision: 'approve',
		});
	});
});

describe('parseSlackApprovalCallback — malformed input returns null', () => {
	it('rejects a body with no payload field', () => {
		expect(parseSlackApprovalCallback('foo=bar')).toBeNull();
		expect(parseSlackApprovalCallback('')).toBeNull();
	});

	it('rejects non-JSON payload', () => {
		expect(parseSlackApprovalCallback('payload=not-json')).toBeNull();
	});

	it('rejects a payload with no Owlat action', () => {
		expect(parseSlackApprovalCallback(formBody(interaction('unrelated_action', 'tok')))).toBeNull();
	});

	it('rejects a missing/blank user id', () => {
		const noUser = formBody({
			actions: [{ action_id: APPROVE_ACTION_ID, value: 'tok' }],
		});
		expect(parseSlackApprovalCallback(noUser)).toBeNull();
		expect(
			parseSlackApprovalCallback(formBody(interaction(APPROVE_ACTION_ID, 'tok', '   ')))
		).toBeNull();
	});

	it('rejects a missing/blank/non-string token', () => {
		expect(parseSlackApprovalCallback(formBody(interaction(APPROVE_ACTION_ID, '')))).toBeNull();
		expect(parseSlackApprovalCallback(formBody(interaction(APPROVE_ACTION_ID, 42)))).toBeNull();
		expect(parseSlackApprovalCallback(formBody(interaction(APPROVE_ACTION_ID, '   ')))).toBeNull();
	});

	it('rejects an over-long token', () => {
		const longToken = 'a'.repeat(200);
		expect(
			parseSlackApprovalCallback(formBody(interaction(APPROVE_ACTION_ID, longToken)))
		).toBeNull();
	});

	it('rejects actions that is not an array', () => {
		expect(
			parseSlackApprovalCallback(formBody({ user: { id: 'U1' }, actions: 'nope' }))
		).toBeNull();
	});
});
