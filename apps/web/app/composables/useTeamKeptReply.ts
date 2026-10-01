/**
 * Text written for a Team inbox reply and not sent, kept per thread for the
 * session. The team reply has no autosaved draft row (its draft is the
 * message's own working draft, saved only on purpose), so leaving Answer mode
 * or undoing a follow-up would otherwise throw the text away. Answer mode puts
 * it back into the editor the next time the thread is answered.
 */
export interface TeamKeptReply {
	body: string;
	subject: string;
}

export function useTeamKeptReply() {
	const kept = useState<Record<string, TeamKeptReply>>('answer:team-kept', () => ({}));
	return {
		get: (threadId: string): TeamKeptReply | null => kept.value[threadId] ?? null,
		set(threadId: string, reply: TeamKeptReply | null) {
			const next = { ...kept.value };
			if (reply && reply.body.trim()) next[threadId] = reply;
			else delete next[threadId];
			kept.value = next;
		},
	};
}
