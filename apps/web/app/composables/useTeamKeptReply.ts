/**
 * Text written for a Team inbox reply and not sent, kept per thread on this
 * device (`useComposerDrafts`). The team reply has no autosaved draft row (its
 * draft is the message's own working draft, saved only on purpose), so leaving
 * Answer mode, undoing a follow-up or reloading the page would otherwise throw
 * the text away. Answer mode puts it back into the editor the next time the
 * thread is answered.
 */
import type { Ref } from 'vue';
import { useComposerDrafts } from '~/composables/useComposerDrafts';

export interface TeamKeptReply {
	body: string;
	subject: string;
	/** A saved reply put `[[...]]` gaps into the text: they still hold Send. */
	gapGuarded?: boolean;
}

function stored(reply: TeamKeptReply | null): TeamKeptReply | null {
	return reply
		? {
				body: reply.body,
				subject: reply.subject,
				...(reply.gapGuarded ? { gapGuarded: true } : {}),
			}
		: null;
}

export function useTeamKeptReply() {
	const drafts = useComposerDrafts();
	return {
		get: (threadId: string): TeamKeptReply | null => drafts.get('team-reply', threadId),
		set(threadId: string, reply: TeamKeptReply | null) {
			drafts.set('team-reply', threadId, stored(reply));
		},
		/**
		 * An updater for the thread's kept text as it belongs to whoever is
		 * signed in now: what resolves after an await (a send, an undone
		 * follow-up) goes through it, never through `set`.
		 */
		pin(threadId: string) {
			const settle = drafts.pin('team-reply', threadId);
			return (update: (current: TeamKeptReply | null) => TeamKeptReply | null) =>
				settle((current) => stored(update(current)));
		},
	};
}

/** The slice of the Team inbox composer (`InboxThreadComposer`) the kept text needs. */
interface KeepingComposer {
	fill: (body: string, subject: string, gapGuarded?: boolean) => void;
	reset: () => void;
	snapshot: () => TeamKeptReply & { touched: boolean };
}

/**
 * Answer mode's side of the kept text. It goes back into `composer` when the
 * editor appears, or when the device copy arrives after it (a reload), unless
 * the person has already typed. What they type is kept as they type it; an
 * editor that goes back to untouched (the agent's draft restored) drops it.
 * A send goes through `sending()`: once the reply is accepted, only the text
 * that was sent is forgotten, and the editor is reset only if it still holds
 * exactly that. Text typed while the send was in flight stays, in the editor
 * and on the device.
 */
export function useKeptTeamComposer(
	threadId: () => string,
	composer: Readonly<Ref<KeepingComposer | null>>
) {
	const kept = useTeamKeptReply();
	watch([composer, () => kept.get(threadId())], ([editor, reply]) => {
		if (editor && reply && !editor.snapshot().touched) {
			editor.fill(reply.body, reply.subject, reply.gapGuarded);
		}
	});
	// Untouched after touched counts only within one editor: a new editor
	// (another message to answer) starts untouched and must not drop the text.
	let lastEditor: KeepingComposer | null = null;
	let wasTouched = false;
	watch(
		() => composer.value?.snapshot(),
		(typed) => {
			const editor = composer.value;
			if (!typed || !editor) return;
			if (typed.touched) kept.set(threadId(), typed);
			else if (editor === lastEditor && wasTouched) kept.set(threadId(), null);
			lastEditor = editor;
			wasTouched = typed.touched;
		}
	);
	return {
		/**
		 * Call when Send is pressed, with what was sent; call the result once
		 * the reply is accepted.
		 */
		sending(sent: { body: string; subject: string }) {
			const editor = composer.value;
			const settle = kept.pin(threadId());
			const isSent = (reply: { body: string; subject: string } | null | undefined) =>
				!!reply && reply.body === sent.body && reply.subject === sent.subject;
			return () => {
				settle((now) => (now === null || isSent(now) ? null : now));
				if (composer.value !== editor || !editor || !isSent(editor.snapshot())) return;
				// This reset is the send finishing, not the person dropping their text.
				wasTouched = false;
				editor.reset();
			};
		},
	};
}
