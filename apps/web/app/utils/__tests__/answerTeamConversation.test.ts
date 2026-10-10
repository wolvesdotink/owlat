import { describe, expect, it } from 'vitest';
import { teamConversationOpenIds } from '../answerTeamConversation';

const msg = (id: string, at: number) => ({ _id: id, _creationTime: at });

describe('a Team inbox thread as a conversation', () => {
	it('opens the newest message, and the one the reply answers', () => {
		const messages = [msg('in_1', 1), msg('in_2', 2), msg('in_3', 3)];
		expect([...teamConversationOpenIds(messages, null)]).toEqual(['in_3']);
		expect([...teamConversationOpenIds(messages, 'in_1')].sort()).toEqual(['in_1', 'in_3']);
	});
});
