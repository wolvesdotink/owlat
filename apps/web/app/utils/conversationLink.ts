/**
 * The shareable link to one conversation, and the way back from it.
 *
 * "Copy link" and "Share in chat…" (the reader's ⋯ menu, the Team Inbox
 * header, the palette) all build the URL here, and the chat message list reads
 * those URLs back with the same rules, so the two ends cannot disagree on what
 * a conversation link looks like.
 *
 * A link grants nothing: whoever opens it goes through the same mailbox or
 * Team Inbox gate as any other read. It only has to say WHICH conversation and,
 * for the Postbox, which inbox it lives in, so a member whose last-used inbox
 * differs still lands in the right one (`?mailbox=`, honoured by
 * `usePostboxMailbox` only for a mailbox the reader can open).
 */

export type ConversationLinkTarget =
	| {
			kind: 'postbox';
			/** Any message of the conversation; the reader opens its whole thread. */
			messageId: string;
			mailboxId: string;
			/** The `[folder]` route segment (a system role or a custom folder id). */
			folder?: string | null;
	  }
	| { kind: 'team'; threadId: string };

/** The in-app route of a conversation, with the mailbox it lives in for the Postbox. */
export function conversationLinkPath(target: ConversationLinkTarget): string {
	if (target.kind === 'team') return `/dashboard/inbox/${encodeURIComponent(target.threadId)}`;
	const folder = encodeURIComponent(target.folder || 'inbox');
	const params = new URLSearchParams({ mailbox: target.mailboxId });
	return `/dashboard/postbox/${folder}/${encodeURIComponent(target.messageId)}?${params}`;
}

function httpOrigin(raw: string | null | undefined): string | null {
	if (!raw) return null;
	try {
		const url = new URL(raw);
		return url.protocol === 'http:' || url.protocol === 'https:' ? url.origin : null;
	} catch {
		return null;
	}
}

/**
 * The origin a copied link points at. In the desktop app the page origin is the
 * webview's own (`tauri://…`), which no browser and no teammate can open, so
 * the active workspace's web address is used instead. `null` when there is no
 * HTTP(S) origin to point at: the caller reports a failed copy rather than
 * handing out a link that cannot work.
 */
export function conversationLinkOrigin(env: {
	desktop: boolean;
	workspaceSiteUrl?: string | null;
	locationOrigin: string;
}): string | null {
	return env.desktop ? httpOrigin(env.workspaceSiteUrl) : httpOrigin(env.locationOrigin);
}

/** The routes a conversation link may lead to. Anything else stays plain text. */
const CONVERSATION_PATH = /^\/dashboard\/(?:postbox\/[^/]+\/[^/]+|inbox\/[^/]+)$/;

/** A bare URL in free text, up to the next whitespace. */
const URL_IN_TEXT = /https?:\/\/\S+/g;

/** Sentence punctuation that ends a URL typed in prose rather than belonging to it. */
const TRAILING_PUNCTUATION = /[.,;:!?)\]}'"]+$/;

export type ConversationLinkSegment =
	| { kind: 'text'; value: string }
	/** `value` is the URL as written; `path` the in-app route it opens. */
	| { kind: 'link'; value: string; path: string };

/**
 * Splits message text into plain text and links to a conversation on THIS
 * instance (`origin`), so the chat list can open them in place. Links to other
 * hosts or to any other route stay plain text: the list is not a general link
 * renderer, and a clickable foreign URL in a team chat is a phishing surface.
 */
export function splitConversationLinks(
	text: string,
	origin: string | null
): ConversationLinkSegment[] {
	const segments: ConversationLinkSegment[] = [];
	let plain = '';
	let last = 0;
	for (const match of origin ? text.matchAll(URL_IN_TEXT) : []) {
		const raw = match[0].replace(TRAILING_PUNCTUATION, '');
		const path = conversationPathOf(raw, origin!);
		if (!path) continue;
		plain += text.slice(last, match.index);
		if (plain) segments.push({ kind: 'text', value: plain });
		plain = '';
		segments.push({ kind: 'link', value: raw, path });
		last = match.index + raw.length;
	}
	plain += text.slice(last);
	if (plain) segments.push({ kind: 'text', value: plain });
	return segments;
}

function conversationPathOf(raw: string, origin: string): string | null {
	let url: URL;
	try {
		url = new URL(raw);
	} catch {
		return null;
	}
	if (url.origin !== origin || !CONVERSATION_PATH.test(url.pathname)) return null;
	return `${url.pathname}${url.search}`;
}
