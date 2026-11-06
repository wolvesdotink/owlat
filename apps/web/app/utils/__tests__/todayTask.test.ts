import { describe, expect, it } from 'vitest';
import type { TodaySource } from '../todayDigest';
import { TODAY_TASK_TITLE_MAX, todayTaskContext } from '../todayTask';

const source = (kind: TodaySource['kind'], threadId: string): TodaySource => ({
	kind,
	id: 'm1',
	threadId,
	mailboxId: kind === 'mail' ? 'mb1' : null,
	fromName: 'Mia',
	fromAddress: 'mia@northwind.example',
	subject: 'Onboarding',
	snippet: '',
	at: 0,
});

describe('todayTaskContext', () => {
	it('links a mail line to its Postbox thread', () => {
		expect(todayTaskContext('Move the call', [source('mail', 'th1')])).toEqual({
			mailThreadId: 'th1',
			defaultTitle: 'Move the call',
		});
	});

	it('links a team line to its Team Inbox thread', () => {
		expect(todayTaskContext('Move the call', [source('team', 'ct1')])).toEqual({
			conversationThreadId: 'ct1',
			defaultTitle: 'Move the call',
		});
	});

	it('suggests a single-line title, shortened when long', () => {
		expect(todayTaskContext('  two\n lines ', []).defaultTitle).toBe('two lines');
		const long = todayTaskContext('word '.repeat(60), []).defaultTitle;
		expect(long.length).toBeLessThanOrEqual(TODAY_TASK_TITLE_MAX);
		expect(long.endsWith('…')).toBe(true);
	});
});
