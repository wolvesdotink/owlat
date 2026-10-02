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
 * generic line, never a sender, subject or chat text.
 */

import type { AppLocale } from '@owlat/shared/appLocales';
import { systemEmailLocale } from '../lib/systemEmailCopy';

/** The JSON the service worker (`apps/web/service-worker/sw.js`) turns into a notification. */
export interface PushPayload {
	title: string;
	body: string;
	/** Collapse key: a newer notification with the same tag replaces the older one. */
	tag: string;
	/** In-app path the click opens or focuses. */
	url: string;
}

interface Copy {
	newMail: string;
	newMessage: string;
	noSubject: string;
	encryptedMail: string;
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
}

const COPY: Record<AppLocale, Copy> = {
	en: {
		newMail: 'New mail',
		newMessage: 'New message',
		noSubject: '(no subject)',
		encryptedMail: 'New encrypted message',
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
	},
	de: {
		newMail: 'Neue E-Mail',
		newMessage: 'Neue Nachricht',
		noSubject: '(kein Betreff)',
		encryptedMail: 'Neue verschlüsselte Nachricht',
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
	},
};

/** Longest title / body we send. Notifications truncate anyway; this keeps the payload small. */
const MAX_TITLE = 80;
const MAX_BODY = 160;

function clip(text: string, max: number): string {
	// Collapse whitespace first: a subject with a newline would render as two lines.
	const flat = text.replace(/\s+/g, ' ').trim();
	return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
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
}

export function mailPayload(
	notice: MailNotice,
	locale: string | undefined,
	isPrivate: boolean
): PushPayload {
	const copy = copyFor(locale);
	const tag = `mail:${notice.threadId}`;
	const url = `/dashboard/postbox/inbox/${notice.messageId}?mailbox=${notice.mailboxId}`;
	if (notice.isSealed) return { title: copy.newMail, body: copy.encryptedMail, tag, url };
	if (isPrivate) return { title: copy.newMail, body: copy.newMessage, tag, url };
	return {
		title: clip(notice.senderName, MAX_TITLE),
		body: clip(notice.subject, MAX_BODY) || copy.noSubject,
		tag,
		url,
	};
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
