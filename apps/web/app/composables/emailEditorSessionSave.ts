import { StaleDraftError } from './useEditorSaveOperation';
import type { EmailEditorCoedit } from './useEmailEditorCoedit';

/**
 * Live: send what this tab still has, then save the shared session (the
 * server writes the session, so nobody's edit that reached it is lost).
 * `write` is the surface's save, given the session version this tab has seen.
 *
 * A draft's save (`checked`) counts as done only once the session this tab
 * saw is written to the email: nothing of this tab left unsent, then the same
 * session reporting a save of at least the version seen. A wait that runs
 * out proves nothing. Two tabs saving the same session at once: the other
 * save moved the row first (a stale refusal here), and it is done when that
 * save wrote what this tab saw (`byOther`).
 */
export async function saveLiveSession(
	live: Pick<EmailEditorCoedit, 'flushNow' | 'seenVersion' | 'meta' | 'untilSaved'>,
	write: (coeditVersion: number | undefined) => Promise<number | void>,
	checked: boolean
): Promise<{ stored: number | void; byOther: boolean }> {
	const delivered = await live.flushNow();
	if (checked && !delivered) throw new Error('Edits not sent to the shared session');
	const seen = live.seenVersion();
	const sessionId = live.meta.value?.sessionId;
	const written = () => {
		const meta = live.meta.value;
		return (
			seen !== undefined && !!meta && meta.sessionId === sessionId && meta.savedVersion >= seen
		);
	};
	let stored: number | void;
	try {
		stored = await write(seen);
	} catch (error) {
		if (!checked || !(error instanceof StaleDraftError) || seen === undefined) throw error;
		await live.untilSaved(seen);
		if (!written()) throw error;
		return { stored: undefined, byOther: true };
	}
	// The leave guard reads the dirty flag right after this resolves.
	if (seen !== undefined) await live.untilSaved(seen);
	if (checked && !written()) throw new Error('Shared session not written to the email');
	return { stored, byOther: false };
}
