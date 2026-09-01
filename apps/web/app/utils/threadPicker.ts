import type { Id } from '@owlat/api/dataModel';

/**
 * Minimal shape of an `inbox.queries.listThreads` row that a thread picker
 * needs to display and select a conversation. Mirrors `PickerContact`.
 */
export interface PickerThread {
	_id: Id<'conversationThreads'>;
	subject: string;
	contactIdentifier?: string;
	lastMessageAt?: number;
}

/** Human label for a thread row — the subject, or a placeholder when empty. */
export function threadPickerLabel(thread: PickerThread): string {
	return thread.subject.trim() || '(no subject)';
}
