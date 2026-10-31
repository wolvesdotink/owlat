/**
 * "Files in this thread": every attachment exchanged in the
 * conversation being answered, as chips the person can click or drag into the
 * reply. Pure: the card lists them, the page attaches them.
 */

import { isRecord } from '@owlat/shared/utils/guards';
import { decodeJsonText, parserDecoder } from '@owlat/worker-protocol/decodeJson';

/** The message fields the file list reads. */
export interface ThreadFileSource {
	_id: string;
	receivedAt: number;
	fromAddress?: string;
	attachments?: readonly {
		filename: string;
		contentType: string;
		size: number;
		/** Absent on mail stored before the MTA recorded it. */
		partIndex?: string;
		contentId?: string;
	}[];
}

export interface ThreadFile {
	/** `<messageId>:<partIndex>`, unique within the thread. */
	key: string;
	messageId: string;
	filename: string;
	contentType: string;
	size: number;
	/** The MIME part; empty when the message predates it (found by filename then). */
	partIndex: string;
	receivedAt: number;
	/** Who sent the message it came with (the index lookup by sender). */
	fromAddress?: string;
}

/** The drag payload type a thread file chip carries into the composer. */
export const THREAD_FILE_DRAG_TYPE = 'application/x-owlat-thread-file';

/**
 * Every real attachment in the thread, newest first. Inline images (a
 * `contentId` referenced by the body) are part of a message's look, not files
 * anyone exchanged, and calendar invites are answered, not forwarded; both are
 * left out. The same file sent twice (a re-send, a forward) is listed once, at
 * its newest copy.
 */
export function threadFilesOf(messages: readonly ThreadFileSource[]): ThreadFile[] {
	const seen = new Set<string>();
	const files: ThreadFile[] = [];
	const newestFirst = [...messages].sort((a, b) => b.receivedAt - a.receivedAt);
	for (const message of newestFirst) {
		for (const att of message.attachments ?? []) {
			if (att.contentId) continue;
			const type = att.contentType.toLowerCase();
			if (type.includes('calendar') || att.filename.toLowerCase().endsWith('.ics')) continue;
			const identity = `${att.filename.toLowerCase()}:${att.size}`;
			if (seen.has(identity)) continue;
			seen.add(identity);
			files.push({
				key: `${message._id}:${att.partIndex ?? att.filename}`,
				messageId: message._id,
				filename: att.filename,
				contentType: att.contentType,
				size: att.size,
				partIndex: att.partIndex ?? '',
				receivedAt: message.receivedAt,
				...(message.fromAddress ? { fromAddress: message.fromAddress } : {}),
			});
		}
	}
	return files;
}

/**
 * A dragged thread file chip. The ids and name are required; the rest of the
 * chip is display detail with a default.
 */
const threadFileDecoder = parserDecoder((value): ThreadFile | null => {
	if (!isRecord(value)) return null;
	const { messageId, filename, partIndex, contentType, size, receivedAt, fromAddress } = value;
	if (typeof messageId !== 'string' || typeof filename !== 'string') return null;
	if (typeof partIndex !== 'string') return null;
	return {
		key: `${messageId}:${partIndex}`,
		messageId,
		filename,
		contentType: typeof contentType === 'string' ? contentType : '',
		size: typeof size === 'number' ? size : 0,
		partIndex,
		receivedAt: typeof receivedAt === 'number' ? receivedAt : 0,
		...(typeof fromAddress === 'string' ? { fromAddress } : {}),
	};
}, '$: expected a thread file');

/** Read a thread file back off a drop, or null when the drop is something else. */
export function threadFileFromDrop(dataTransfer: DataTransfer | null): ThreadFile | null {
	const raw = dataTransfer?.getData(THREAD_FILE_DRAG_TYPE);
	if (!raw) return null;
	const decoded = decodeJsonText(raw, threadFileDecoder);
	return decoded.ok ? decoded.value : null;
}
