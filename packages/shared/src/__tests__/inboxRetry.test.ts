import { describe, expect, it } from 'vitest';
import { holdsHumanReply, inboxRetryPlan } from '../inboxRetry';

describe('inboxRetryPlan', () => {
	it('sends a failed send of a person’s approval again', () => {
		expect(
			inboxRetryPlan({ failedStage: 'send', approvalSource: 'human', draftResponse: 'Hi' })
		).toBe('sendAgain');
		// Approved before `approvalSource` existed: read as a person's.
		expect(inboxRetryPlan({ failedStage: 'send', draftResponse: 'Hi' })).toBe('sendAgain');
	});

	it('never sends again what the router approved', () => {
		expect(
			inboxRetryPlan({ failedStage: 'send', approvalSource: 'auto', draftResponse: 'Hi' })
		).toBe('redraft');
	});

	it('returns a person’s reply to review when it cannot simply be sent again', () => {
		// No text left to send.
		expect(
			inboxRetryPlan({ failedStage: 'send', approvalSource: 'human', draftResponse: ' ' })
		).toBe('review');
		// Failed before the stage was recorded.
		expect(inboxRetryPlan({ approvalSource: 'human', draftResponse: 'Hi' })).toBe('review');
		// A step failed after a person saved, took over or edited.
		expect(inboxRetryPlan({ failedStage: 'pipeline', draftSavedAt: 1 })).toBe('review');
		expect(inboxRetryPlan({ failedStage: 'pipeline', manualTakeoverAt: 1 })).toBe('review');
		expect(inboxRetryPlan({ failedStage: 'pipeline', draftRevisions: [{}] })).toBe('review');
		expect(inboxRetryPlan({ isDraftEdited: true })).toBe('review');
	});

	it('re-runs the agent when nobody touched the reply', () => {
		expect(inboxRetryPlan({ failedStage: 'pipeline' })).toBe('redraft');
		expect(inboxRetryPlan({ failedStage: 'pipeline', draftResponse: 'agent text' })).toBe(
			'redraft'
		);
		expect(inboxRetryPlan({})).toBe('redraft');
		expect(holdsHumanReply({ draftRevisions: [] })).toBe(false);
	});
});
