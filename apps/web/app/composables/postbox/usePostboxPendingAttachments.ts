/**
 * Transient hand-off for an attachment the app generates (e.g. an iCalendar
 * RSVP REPLY) and wants the next-opened composer to attach. The composer reads
 * it by key on mount and clears it. Plain string content (serializable), so it
 * survives the ComposerSpec hop through useState.
 */
export interface PendingAttachment {
	filename: string;
	contentType: string;
	content: string;
}

export function usePostboxPendingAttachments() {
	const store = useState<Record<string, PendingAttachment>>(
		'postbox:pending-attachments',
		() => ({})
	);

	function stash(att: PendingAttachment): string {
		const key = `pa_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
		store.value = { ...store.value, [key]: att };
		return key;
	}

	function take(key: string): PendingAttachment | null {
		const att = store.value[key];
		if (!att) return null;
		const next = { ...store.value };
		delete next[key];
		store.value = next;
		return att;
	}

	return { stash, take };
}
