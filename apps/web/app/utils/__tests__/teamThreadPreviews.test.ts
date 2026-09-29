import { afterEach, describe, expect, it } from 'vitest';
import {
	TEAM_THREAD_PREVIEW_LIMIT,
	clearTeamThreadPreviews,
	rememberTeamThreadPreviews,
	teamThreadPreview,
} from '../teamThreadPreviews';

/**
 * The Team Inbox list's rows, kept for the thread page's loading header.
 */
const row = (id: string, subject = `Subject ${id}`) => ({
	_id: id,
	subject,
	contactIdentifier: `${id}@example.com`,
	messageCount: 2,
	status: 'open',
});

afterEach(() => clearTeamThreadPreviews());

describe('teamThreadPreviews', () => {
	it('returns null for a thread the list never showed', () => {
		expect(teamThreadPreview('t1')).toBeNull();
	});

	it('keeps only the header fields of a remembered row', () => {
		rememberTeamThreadPreviews([row('t1')]);
		expect(teamThreadPreview('t1')).toEqual({
			subject: 'Subject t1',
			contactIdentifier: 't1@example.com',
			messageCount: 2,
		});
	});

	it('lets the newest write win', () => {
		rememberTeamThreadPreviews([row('t1', 'Old')]);
		rememberTeamThreadPreviews([row('t1', 'New')]);
		expect(teamThreadPreview('t1')?.subject).toBe('New');
	});

	it('drops the least recently seen rows past the limit', () => {
		rememberTeamThreadPreviews([row('first'), row('second')]);
		// Seeing `first` again makes `second` the oldest.
		rememberTeamThreadPreviews([row('first')]);
		const filler = Array.from({ length: TEAM_THREAD_PREVIEW_LIMIT - 1 }, (_, i) => row(`f${i}`));
		rememberTeamThreadPreviews(filler);
		expect(teamThreadPreview('second')).toBeNull();
		expect(teamThreadPreview('first')).not.toBeNull();
		expect(teamThreadPreview(`f${TEAM_THREAD_PREVIEW_LIMIT - 2}`)).not.toBeNull();
	});
});
