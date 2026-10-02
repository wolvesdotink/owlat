/**
 * Text written for a Team inbox reply and not sent, kept per thread for the
 * session. The team reply has no autosaved draft row (its draft is the
 * message's own working draft, saved only on purpose), so leaving Answer mode
 * or undoing a follow-up would otherwise throw the text away. Answer mode puts
 * it back into the editor the next time the thread is answered.
 */
import type { Ref } from 'vue';

export interface TeamKeptReply {
	body: string;
	subject: string;
	/** A saved reply put `[[...]]` gaps into the text: they still hold Send. */
	gapGuarded?: boolean;
}

export function useTeamKeptReply() {
	const kept = useState<Record<string, TeamKeptReply>>('answer:team-kept', () => ({}));
	return {
		get: (threadId: string): TeamKeptReply | null => kept.value[threadId] ?? null,
		set(threadId: string, reply: TeamKeptReply | null) {
			const next = { ...kept.value };
			if (reply && reply.body.trim()) {
				next[threadId] = { body: reply.body, subject: reply.subject, gapGuarded: reply.gapGuarded };
			} else delete next[threadId];
			kept.value = next;
		},
	};
}

/** The slice of the Team inbox composer (`InboxThreadComposer`) the kept text needs. */
interface KeepingComposer {
	fill: (body: string, subject: string, gapGuarded?: boolean) => void;
	snapshot: () => TeamKeptReply & { touched: boolean };
}

/**
 * Answer mode's side of the kept text: it goes back into `composer` when the
 * editor appears, `keep()` stores what the person typed (nothing when they did
 * not type), and `clear()` forgets it once the reply is sent.
 */
export function useKeptTeamComposer(
	threadId: () => string,
	composer: Readonly<Ref<KeepingComposer | null>>
) {
	const kept = useTeamKeptReply();
	watch(composer, (editor) => {
		const reply = kept.get(threadId());
		if (editor && reply) editor.fill(reply.body, reply.subject, reply.gapGuarded);
	});
	return {
		keep() {
			const typed = composer.value?.snapshot();
			kept.set(threadId(), typed?.touched ? typed : null);
		},
		clear: () => kept.set(threadId(), null),
	};
}
