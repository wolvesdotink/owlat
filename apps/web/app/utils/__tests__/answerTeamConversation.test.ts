import { describe, expect, it } from 'vitest';
import { teamConversationEntries, teamConversationOpenIds } from '../answerTeamConversation';

const msg = (id: string, at: number, over: Record<string, unknown> = {}) => ({
	_id: id,
	_creationTime: at,
	processingStatus: 'draft_ready',
	...over,
});

describe('a Team inbox thread as a conversation', () => {
	it('reads each message, then the reply that answered it, then its follow-ups', () => {
		const messages = [
			msg('in_2', 2),
			msg('in_1', 1, { processingStatus: 'sent', draftResponse: 'Here it is.' }),
		];
		const followUps = [{ _id: 'fu_1', inReplyToMessageId: 'in_1' }];
		expect(teamConversationEntries(messages, followUps).map((e) => e.key)).toEqual([
			'in_1',
			'reply:in_1',
			'fu_1',
			'in_2',
		]);
	});

	it('shows no reply for a message whose draft never went out', () => {
		const entries = teamConversationEntries([msg('in_1', 1, { draftResponse: 'Draft' })], []);
		expect(entries.map((e) => e.kind)).toEqual(['inbound']);
	});

	it('opens the newest message, and the one the reply answers', () => {
		const messages = [msg('in_1', 1), msg('in_2', 2), msg('in_3', 3)];
		expect([...teamConversationOpenIds(messages, null)]).toEqual(['in_3']);
		expect([...teamConversationOpenIds(messages, 'in_1')].sort()).toEqual(['in_1', 'in_3']);
	});
});
