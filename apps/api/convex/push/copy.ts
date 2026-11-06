/**
 * What a Web Push notification says, in the recipient's language.
 *
 * Composed on the server (the sender runs on a scheduler, with no browser and
 * no vue-i18n behind it), so the sentences live here the way system-email copy
 * lives in `lib/systemEmailCopy.ts`, keyed by `userProfiles.locale` and falling
 * back to English. The wording mirrors the desktop toasts
 * (`shared.useDesktopNotifications` / `shared.inbox.assignmentNoticeRules` in
 * the web catalogs) so the two surfaces read the same.
 *
 * Privacy is decided here, once: a private notification (the shared "hide
 * message preview" preference) and any sealed (E2EE) message carry only a
 * generic line, never a sender, subject or chat text. A sign-in code never
 * travels in a payload at all: its "Copy code" button opens the message, and
 * the reader copies the code from there.
 */

import type { AppLocale } from '@owlat/shared/appLocales';
import { systemEmailLocale } from '../lib/systemEmailCopy';
import type { McpWriteToolName } from '../lib/validators/mcp';

/** The JSON the service worker (`apps/web/service-worker/sw.js`) turns into a notification. */
export interface PushPayload {
	title: string;
	body: string;
	/** Collapse key: a newer notification with the same tag replaces the older one. */
	tag: string;
	/** In-app path the click opens or focuses. */
	url: string;
	/**
	 * Buttons on the notification, each opening its own in-app path. Where the
	 * platform shows no buttons, a click still opens `url`.
	 */
	actions?: PushAction[];
}

export interface PushAction {
	/** Stable id the service worker hands back on click. */
	action: string;
	title: string;
	url: string;
}

interface Copy {
	newMail: string;
	newMessage: string;
	noSubject: string;
	encryptedMail: string;
	copyCode: string;
	assignedTitle: string;
	assignedBody: (subject: string, by: string) => string;
	assignedPrivate: string;
	clarificationTitle: string;
	clarificationBody: (subject: string) => string;
	clarificationPrivate: string;
	chatTitle: string;
	chatMention: (author: string, room: string) => string;
	sealedThread: string;
	chatPrivate: string;
	quietTitle: string;
	quietBody: (count: number) => string;
	testTitle: string;
	testBody: string;
	mcpTitle: string;
	mcpBody: (client: string, verb: string) => string;
	mcpPrivate: string;
	mcpVerbs: Record<McpWriteToolName, string>;
}

const COPY: Record<AppLocale, Copy> = {
	en: {
		newMail: 'New mail',
		newMessage: 'New message',
		noSubject: '(no subject)',
		encryptedMail: 'New encrypted message',
		copyCode: 'Copy code',
		assignedTitle: 'Assigned to you',
		assignedBody: (subject, by) => `${subject} · from ${by}`,
		assignedPrivate: 'A conversation was assigned to you',
		clarificationTitle: 'Your input is needed',
		clarificationBody: (subject) => `${subject} · the agent has a question for you`,
		clarificationPrivate: 'The agent has a question for you',
		chatTitle: 'New chat message',
		chatMention: (author, room) => `${author} in ${room}`,
		sealedThread: 'an encrypted conversation',
		chatPrivate: 'You have a new chat message',
		quietTitle: 'While you were away',
		quietBody: (count) =>
			count === 1
				? '1 notification arrived during quiet hours'
				: `${count} notifications arrived during quiet hours`,
		testTitle: 'Notifications are on',
		testBody: 'This device will show Owlat notifications.',
		mcpTitle: 'Approval needed',
		mcpBody: (client, verb) => `${client} wants to ${verb}`,
		mcpPrivate: 'An AI client is waiting for your approval',
		mcpVerbs: {
			create_draft: 'create a draft',
			send_draft: 'send an email',
			archive_thread: 'archive a conversation',
			move_thread: 'move a conversation',
			label_thread: 'label a conversation',
		},
	},
	de: {
		newMail: 'Neue E-Mail',
		newMessage: 'Neue Nachricht',
		noSubject: '(kein Betreff)',
		encryptedMail: 'Neue verschlüsselte Nachricht',
		copyCode: 'Code kopieren',
		assignedTitle: 'Dir zugewiesen',
		assignedBody: (subject, by) => `${subject} · von ${by}`,
		assignedPrivate: 'Dir wurde eine Konversation zugewiesen',
		clarificationTitle: 'Deine Eingabe wird gebraucht',
		clarificationBody: (subject) => `${subject} · der Agent hat eine Frage an dich`,
		clarificationPrivate: 'Der Agent hat eine Frage an dich',
		chatTitle: 'Neue Chat-Nachricht',
		chatMention: (author, room) => `${author} in ${room}`,
		sealedThread: 'einer verschlüsselten Konversation',
		chatPrivate: 'Du hast eine neue Chat-Nachricht',
		quietTitle: 'Während du weg warst',
		quietBody: (count) =>
			count === 1
				? '1 Benachrichtigung ist während der Ruhezeiten eingegangen'
				: `${count} Benachrichtigungen sind während der Ruhezeiten eingegangen`,
		testTitle: 'Benachrichtigungen sind an',
		testBody: 'Dieses Gerät zeigt Owlat-Benachrichtigungen an.',
		mcpTitle: 'Freigabe nötig',
		mcpBody: (client, verb) => `${client} möchte ${verb}`,
		mcpPrivate: 'Ein KI-Client wartet auf deine Freigabe',
		mcpVerbs: {
			create_draft: 'einen Entwurf anlegen',
			send_draft: 'eine E-Mail senden',
			archive_thread: 'eine Konversation archivieren',
			move_thread: 'eine Konversation verschieben',
			label_thread: 'eine Konversation mit einem Label versehen',
		},
	},
};

/** Longest title / body we send. Notifications truncate anyway; this keeps the payload small. */
const MAX_TITLE = 80;
const MAX_BODY = 160;

function clip(text: string, max: number): string {
	// Collapse whitespace first: a subject with a newline would render as two lines.
	const flat = text.replace(/\s+/g, ' ').trim();
	// Count code points, not UTF-16 units: a cut through an emoji's surrogate
	// pair would leave half of it, which renders as "�".
	const chars = Array.from(flat);
	return chars.length > max ? `${chars.slice(0, max - 1).join('')}…` : flat;
}

function copyFor(locale: string | undefined): Copy {
	return COPY[systemEmailLocale(locale)];
}

/** Everything a mail notification can say; the builder decides how much it does. */
export interface MailNotice {
	threadId: string;
	messageId: string;
	mailboxId: string;
	senderName: string;
	subject: string;
	/** The message arrived sealed (PGP/MIME): never show anything from it. */
	isSealed: boolean;
	/** The message carries a live one-time code (mail/signInCodes.ts). */
	hasSignInCode?: boolean;
}

/**
 * The reader copies the open message's code once when its route carries this
 * query (`usePostboxSignInCodeIntent` in the web app). A service worker cannot
 * write to the clipboard, so the button can only hand the copy to the page.
 */
export const SIGN_IN_CODE_COPY_QUERY = 'signInCode=copy';

export function mailPayload(
	notice: MailNotice,
	locale: string | undefined,
	isPrivate: boolean
): PushPayload {
	const copy = copyFor(locale);
	const tag = `mail:${notice.threadId}`;
	const url = `/dashboard/postbox/inbox/${notice.messageId}?mailbox=${notice.mailboxId}`;
	if (notice.isSealed) return { title: copy.newMail, body: copy.encryptedMail, tag, url };
	// A sign-in link gets no button: opening the message is already one click
	// from its chip, and the link itself never leaves the server in a payload.
	const actions: PushAction[] | undefined = notice.hasSignInCode
		? [{ action: 'copy-code', title: copy.copyCode, url: `${url}&${SIGN_IN_CODE_COPY_QUERY}` }]
		: undefined;
	const text = isPrivate
		? { title: copy.newMail, body: copy.newMessage }
		: {
				title: clip(notice.senderName, MAX_TITLE),
				body: clip(notice.subject, MAX_BODY) || copy.noSubject,
			};
	return { ...text, tag, url, ...(actions ? { actions } : {}) };
}

export interface AssignmentNoticeCopy {
	threadId: string;
	kind: 'assignment' | 'clarification';
	subject: string;
	assignedByName: string;
}

export function assignmentPayload(
	notice: AssignmentNoticeCopy,
	locale: string | undefined,
	isPrivate: boolean
): PushPayload {
	const copy = copyFor(locale);
	const tag = `inbox:${notice.threadId}`;
	const url = `/dashboard/inbox/${notice.threadId}`;
	const subject = clip(notice.subject, MAX_BODY) || copy.noSubject;
	if (notice.kind === 'clarification') {
		return {
			title: copy.clarificationTitle,
			body: isPrivate ? copy.clarificationPrivate : clip(copy.clarificationBody(subject), MAX_BODY),
			tag,
			url,
		};
	}
	return {
		title: copy.assignedTitle,
		body: isPrivate
			? copy.assignedPrivate
			: clip(copy.assignedBody(subject, clip(notice.assignedByName, MAX_TITLE)), MAX_BODY),
		tag,
		url,
	};
}

export interface ChatNotice {
	roomId: string;
	authorName: string;
	/** Channel name for a mention; absent for a direct message. */
	roomName?: string;
	/** A discussion of a sealed (E2EE) email: its subject is never shown. */
	isSealedThread?: boolean;
	text: string;
	/** Where the click goes: the room, or the email a team discussion belongs to. */
	url: string;
}

export function chatPayload(
	notice: ChatNotice,
	locale: string | undefined,
	isPrivate: boolean
): PushPayload {
	const copy = copyFor(locale);
	const tag = `chat:${notice.roomId}`;
	if (isPrivate) return { title: copy.chatTitle, body: copy.chatPrivate, tag, url: notice.url };
	const roomName = notice.isSealedThread ? copy.sealedThread : notice.roomName;
	const title = roomName
		? copy.chatMention(clip(notice.authorName, 40), clip(roomName, 40))
		: notice.authorName;
	return {
		title: clip(title, MAX_TITLE),
		body: clip(notice.text, MAX_BODY) || copy.chatTitle,
		tag,
		url: notice.url,
	};
}

export function quietSummaryPayload(count: number, locale: string | undefined): PushPayload {
	const copy = copyFor(locale);
	return {
		title: copy.quietTitle,
		body: copy.quietBody(count),
		tag: 'quiet-summary',
		url: '/dashboard',
	};
}

export function testPayload(locale: string | undefined): PushPayload {
	const copy = copyFor(locale);
	return {
		title: copy.testTitle,
		body: copy.testBody,
		tag: 'test',
		url: '/dashboard/preferences/device#push',
	};
}

/** Where an approval notification opens: the waiting actions on the AI clients page. */
export const MCP_APPROVALS_URL = '/dashboard/preferences/ai-clients#approvals';

export function mcpActionPayload(
	notice: { actionId: string; clientLabel: string; tool: McpWriteToolName },
	locale: string | undefined,
	isPrivate: boolean
): PushPayload {
	const copy = copyFor(locale);
	return {
		title: copy.mcpTitle,
		body: isPrivate
			? copy.mcpPrivate
			: clip(copy.mcpBody(clip(notice.clientLabel, 40), copy.mcpVerbs[notice.tool]), MAX_BODY),
		tag: `mcp:${notice.actionId}`,
		url: MCP_APPROVALS_URL,
	};
}
