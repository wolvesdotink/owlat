import { describe, it, expect } from 'vitest';
import { composeContextForPath } from '../composeContext';

describe('composeContextForPath', () => {
	it('addresses a composer opened on a contact page to that contact', () => {
		expect(composeContextForPath('/dashboard/audience/contacts/c_1')).toEqual({
			kind: 'contact',
			contactId: 'c_1',
		});
		expect(composeContextForPath('/dashboard/audience/topics/t_1/contacts/c_2')).toEqual({
			kind: 'contact',
			contactId: 'c_2',
		});
	});

	it('answers a Team inbox thread, but not the static inbox pages beside it', () => {
		expect(composeContextForPath('/dashboard/inbox/thread_1')).toEqual({
			kind: 'thread',
			threadId: 'thread_1',
		});
		for (const page of ['activity', 'code-tasks', 'failed', 'quarantine', 'review', 'updates']) {
			expect(composeContextForPath(`/dashboard/inbox/${page}`), page).toBeNull();
		}
		expect(composeContextForPath('/dashboard/inbox')).toBeNull();
	});

	it('has no context on list pages or elsewhere', () => {
		expect(composeContextForPath('/dashboard/audience/contacts')).toBeNull();
		expect(composeContextForPath('/dashboard')).toBeNull();
		expect(composeContextForPath('/dashboard/campaigns/abc/edit')).toBeNull();
	});
});
