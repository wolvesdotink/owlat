import { describe, expect, it } from 'vitest';
import type { UnreadPeekMessage } from '../notificationRules';
import { emptyTrayContent, trayContent, type TrayInput } from '../trayContent';

function message(id: string, extra: Partial<UnreadPeekMessage> = {}): UnreadPeekMessage {
	return {
		messageId: id,
		threadId: `t-${id}`,
		fromName: `Sender ${id}`,
		fromAddress: `${id}@example.com`,
		subject: `About ${id}`,
		receivedAt: 1,
		...extra,
	};
}

const base: TrayInput = {
	count: 2,
	messages: [message('a'), message('b')],
	badgeNonPeople: true,
	hidePreview: false,
	notificationsEnabled: true,
	workspaceId: 'ws-1',
};

describe('trayContent', () => {
	it('lists the peek newest first with sender and subject', () => {
		expect(trayContent(base)).toEqual({
			unread: 2,
			messages: [
				{ messageId: 'a', sender: 'Sender a', subject: 'About a' },
				{ messageId: 'b', sender: 'Sender b', subject: 'About b' },
			],
			workspaceId: 'ws-1',
			notificationsPaused: false,
		});
	});

	it('names a sender without a display name by address', () => {
		const content = trayContent({
			...base,
			messages: [message('a', { fromName: undefined }), message('b', { fromName: '  ' })],
		});
		expect(content.messages.map((m) => m.sender)).toEqual(['a@example.com', 'b@example.com']);
	});

	it('keeps the count but no mail content while previews are hidden', () => {
		const content = trayContent({ ...base, hidePreview: true });
		expect(content.unread).toBe(2);
		expect(content.messages).toEqual([]);
	});

	it('lists only the mail a people-only count covers', () => {
		const content = trayContent({
			...base,
			count: 1,
			badgeNonPeople: false,
			messages: [
				message('news', { category: 'newsletter' }),
				message('ada', { category: 'person' }),
			],
		});
		expect(content.messages.map((m) => m.messageId)).toEqual(['ada']);
	});

	it('lists nothing before the first count arrives', () => {
		expect(trayContent({ ...base, count: null }).messages).toEqual([]);
	});

	it('reports notifications as paused when the master switch is off', () => {
		expect(trayContent({ ...base, notificationsEnabled: false }).notificationsPaused).toBe(true);
	});
});

describe('emptyTrayContent', () => {
	it('carries no count, no mail and no workspace', () => {
		expect(emptyTrayContent(false)).toEqual({
			unread: null,
			messages: [],
			workspaceId: null,
			notificationsPaused: true,
		});
	});
});
