/**
 * What the desktop tray icon shows (src-tauri tray.rs), derived from the same
 * unread peek and count as the dock badge (`useUnreadBadge`). Pure.
 */
import type { TrayContent, TrayMessage } from '@owlat/desktop/src/tray';
import { countsInPeopleBadge, type UnreadPeekMessage } from '~/lib/desktop/notificationRules';

export interface TrayInput {
	/** The badge count; `null` before the first delivery. */
	count: number | null;
	/** The peek's newest-first unread window. */
	messages: readonly UnreadPeekMessage[];
	/**
	 * The "count all mail in the badge" preference. When it is off the count
	 * covers people only, and the rows follow it so they never list mail the
	 * count leaves out.
	 */
	badgeNonPeople: boolean;
	/**
	 * The "hide message previews" preference. The rows are mail content on
	 * screen, like a notification's, so it hides them and keeps the count.
	 */
	hidePreview: boolean;
	notificationsEnabled: boolean;
	workspaceId: string | null;
}

function trayMessage(message: UnreadPeekMessage): TrayMessage {
	return {
		messageId: message.messageId,
		sender: message.fromName?.trim() || message.fromAddress,
		subject: message.subject,
	};
}

export function trayContent(input: TrayInput): TrayContent {
	return {
		unread: input.count,
		messages:
			input.hidePreview || input.count === null
				? []
				: input.messages
						.filter((m) => input.badgeNonPeople || countsInPeopleBadge(m))
						.map(trayMessage),
		workspaceId: input.workspaceId,
		notificationsPaused: !input.notificationsEnabled,
	};
}

/** What a page without unread state reports: the verbs and nothing else. */
export function emptyTrayContent(notificationsEnabled: boolean): TrayContent {
	return trayContent({
		count: null,
		messages: [],
		badgeNonPeople: true,
		hidePreview: false,
		notificationsEnabled,
		workspaceId: null,
	});
}
