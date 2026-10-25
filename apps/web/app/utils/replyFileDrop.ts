/**
 * Dropping files on a conversation (a list row or the open reader) replies to
 * it with them: Answer mode opens on the conversation and the files arrive as
 * attachments. The pure half lives here: what a drop target is, which drags
 * count as file drags, who the reply goes to, and the queue that carries the
 * dropped `File` objects across the navigation into Answer mode.
 *
 * The files never touch the URL or a persisted draft: they live in client
 * memory between the drop and the Answer mode page taking them, so a reload
 * in between simply drops them.
 */
import { extractEmailAddress } from '~/utils/emailAddress';
import type { AnswerModeKind } from '~/utils/answerMode';
import { knownRecipientLabel, messageRecipientNames } from '~/utils/recipientHints';

/** Which Answer mode page a reply drop opens. */
export type ReplyDropRef = { kind: 'message'; id: string } | { kind: 'team'; id: string };

/** A conversation that takes a file drop as a reply. */
export type ReplyDropTarget = ReplyDropRef & {
	/**
	 * Who the reply goes to, for "Drop to reply to Ines with 2 files"; empty
	 * when the row cannot say (a reply to one's own message with no To or Cc
	 * on the row), and the hint leaves the name out.
	 */
	recipient: string;
	/** A Postbox reply's composer kind; absent opens the person's default reply. */
	replyKind?: AnswerModeKind | null;
	/** A Team inbox reply's inbound message, when it is not the thread's own pick. */
	messageId?: string | null;
	/**
	 * Runs `proceed` once the reply may be opened (the sender-auth reply guard).
	 * Nothing is queued before it proceeds, so a cancelled guard leaves no files
	 * waiting for a later visit to Answer mode.
	 */
	guard?: (proceed: () => void) => void;
};

export function sameReplyDropRef(a: ReplyDropRef, b: ReplyDropRef): boolean {
	return a.kind === b.kind && a.id === b.id;
}

/** The type browsers list for a drag that carries files from the OS. */
const FILES_TYPE = 'Files';

/**
 * True when a drag carries files from outside the page. Text, links and the
 * thread list's own row drags carry no `Files` type and are left alone.
 */
export function isFileDrag(dataTransfer: DataTransfer | null | undefined): boolean {
	if (!dataTransfer) return false;
	return Array.from(dataTransfer.types ?? []).includes(FILES_TYPE);
}

/**
 * How many files a drag carries while it is still in the air. Browsers keep
 * `files` empty until the drop but list one `items` entry per file; a browser
 * that hides even those (Safari) yields null, and the hint leaves the count out.
 */
export function draggedFileCount(dataTransfer: DataTransfer | null | undefined): number | null {
	const items = dataTransfer?.items;
	if (!items) return null;
	let count = 0;
	for (const item of Array.from(items)) if (item.kind === 'file') count += 1;
	return count > 0 ? count : null;
}

/** The slice of a Postbox message a reply drop reads. */
export interface ReplyDropMessage {
	_id: string;
	fromAddress: string;
	fromName?: string | null;
	toAddresses?: string[];
	ccAddresses?: string[];
}

/**
 * Who a reply to `msg` goes to, named the way the thread names people. A
 * reply to one's own message goes to the people it went to (its To, else its
 * Cc), the rule the composer's reply seed follows; anything else goes back to
 * the sender.
 */
export function replyDropRecipient(
	msg: ReplyDropMessage,
	ownAddresses: ReadonlySet<string> = new Set()
): string {
	const isOwn = (address: string) => ownAddresses.has(extractEmailAddress(address));
	if (isOwn(msg.fromAddress)) {
		const others = (list: string[] | undefined) => (list ?? []).filter((a) => !isOwn(a));
		const first = others(msg.toAddresses)[0] ?? others(msg.ccAddresses)[0];
		return first ? knownRecipientLabel(first, messageRecipientNames(msg)) : '';
	}
	return msg.fromName?.trim() || msg.fromAddress;
}

/**
 * The reply drop for a Postbox list row, or null where a reply makes no
 * sense (a draft is not a message anyone answers). A row in Sent is the
 * person's own message, so its reply goes to the people it went to.
 */
export function replyDropForMessage(
	msg: ReplyDropMessage,
	folderRole?: string | null
): ReplyDropTarget | null {
	if (folderRole === 'drafts') return null;
	const own = folderRole === 'sent' ? new Set([extractEmailAddress(msg.fromAddress)]) : undefined;
	return { kind: 'message', id: msg._id, recipient: replyDropRecipient(msg, own) };
}

interface QueuedReplyDrop {
	id: number;
	ref: ReplyDropRef;
	files: File[];
}

/**
 * The files dropped on conversations, waiting for their Answer mode page.
 * Each entry is taken exactly once, and only by the page of the conversation
 * it was dropped on; ids are compared by kind and id together, so a Postbox
 * message and a Team thread can never take each other's files.
 */
export function createReplyDropQueue(onChange: () => void = () => {}) {
	let entries: QueuedReplyDrop[] = [];
	let nextId = 0;

	function set(next: QueuedReplyDrop[]) {
		if (next.length === entries.length) return;
		entries = next;
		onChange();
	}

	return {
		/** Queue `files` for `ref`'s Answer mode page; returns the entry's id. */
		queue(ref: ReplyDropRef, files: File[]): number {
			nextId += 1;
			entries = [...entries, { id: nextId, ref: { kind: ref.kind, id: ref.id }, files }];
			onChange();
			return nextId;
		},
		/** Take every file waiting for `ref` (oldest first), or [] when none are. */
		take(ref: ReplyDropRef): File[] {
			const mine = entries.filter((entry) => sameReplyDropRef(entry.ref, ref));
			if (mine.length === 0) return [];
			set(entries.filter((entry) => !sameReplyDropRef(entry.ref, ref)));
			return mine.flatMap((entry) => entry.files);
		},
		/** Whether files are waiting for `ref`. */
		has(ref: ReplyDropRef): boolean {
			return entries.some((entry) => sameReplyDropRef(entry.ref, ref));
		},
		/** Forget one queued drop (its navigation did not land). */
		remove(id: number): void {
			set(entries.filter((entry) => entry.id !== id));
		},
		/** Forget everything waiting for `ref`; true when something was waiting. */
		clear(ref: ReplyDropRef): boolean {
			const before = entries.length;
			set(entries.filter((entry) => !sameReplyDropRef(entry.ref, ref)));
			return entries.length < before;
		},
		/** Forget every queued drop (the account or workspace changed). */
		clearAll(): void {
			set([]);
		},
	};
}

export type ReplyDropQueue = ReturnType<typeof createReplyDropQueue>;
