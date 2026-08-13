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

/**
 * Narrow a page of threads to those matching the typed query, over the subject
 * and the participant address. `conversationThreads` has no full-text index, so
 * the picker filters a bounded recent page client-side — the same approach the
 * chat "link an email thread" dialog takes.
 */
export function filterThreadCandidates(threads: PickerThread[], query: string): PickerThread[] {
	const needle = query.trim().toLowerCase();
	if (!needle) return threads;
	return threads.filter(
		(thread) =>
			thread.subject.toLowerCase().includes(needle) ||
			(thread.contactIdentifier ?? '').toLowerCase().includes(needle)
	);
}
