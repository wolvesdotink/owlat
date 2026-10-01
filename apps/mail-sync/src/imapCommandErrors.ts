/**
 * How the write-back (remoteOps.ts) reads an IMAP command that failed.
 *
 * ImapFlow rejects a refused SELECT, STATUS, RENAME or DELETE, but not a
 * refused MOVE, COPY, STORE or EXPUNGE: it logs the error and resolves `false`
 * (or nothing at all, when the command could not be sent). To say why such a
 * command failed, the write-back needs the error ImapFlow logged;
 * `CommandRefusals.logger` is the ImapFlow `logger` that keeps it.
 */

const ignore = (): void => {};

/** The error ImapFlow last logged a warning with, for the command that just resolved `false`. */
export class CommandRefusals {
	private last: unknown;

	/**
	 * An ImapFlow `logger` that keeps each warning's error and drops everything
	 * else, as `logger: false` does.
	 */
	readonly logger = {
		trace: ignore,
		debug: ignore,
		info: ignore,
		warn: (entry: unknown): void => {
			const err = entry && typeof entry === 'object' ? (entry as { err?: unknown }).err : undefined;
			if (err !== undefined) this.last = err;
		},
		error: ignore,
		fatal: ignore,
	};

	/** The last logged error, cleared so the next command starts without it. */
	take(): unknown {
		const err = this.last;
		this.last = undefined;
		return err;
	}
}

/**
 * The error a refused `command` fails its op with: the server's status,
 * response code and text from the error ImapFlow logged, when there was one.
 */
export function refusedCommand(command: string, logged: unknown): Error {
	const err = new Error(`${command} failed`);
	if (logged && typeof logged === 'object') {
		const { code, responseStatus, serverResponseCode, responseText } = logged as Record<
			string,
			unknown
		>;
		Object.assign(err, { code, responseStatus, serverResponseCode, responseText });
	}
	return err;
}

/**
 * The server said the mailbox does not exist: ImapFlow's LIST check after a
 * refused SELECT (`mailboxMissing`) or STATUS (`NotFound`), or the server's own
 * NONEXISTENT response code. Anything else — UNAVAILABLE, throttling, a
 * permission refusal — says nothing about whether the folder is there.
 */
export function isMissingMailbox(err: unknown): boolean {
	if (!err || typeof err !== 'object') return false;
	const e = err as { mailboxMissing?: unknown; code?: unknown; serverResponseCode?: unknown };
	return (
		e.mailboxMissing === true ||
		e.code === 'NotFound' ||
		(typeof e.serverResponseCode === 'string' &&
			e.serverResponseCode.toUpperCase() === 'NONEXISTENT')
	);
}

/**
 * What to record as a failed op's error. ImapFlow's message for a refused
 * command is only "Command failed"; the server's status, response code and
 * text carry the reason.
 */
export function describeRemoteOpError(err: unknown): string {
	if (!(err instanceof Error)) return String(err);
	const e = err as Error & {
		code?: unknown;
		responseStatus?: unknown;
		serverResponseCode?: unknown;
		responseText?: unknown;
	};
	const detail = [
		e.responseStatus,
		typeof e.serverResponseCode === 'string' ? `[${e.serverResponseCode}]` : undefined,
		e.responseText,
	].filter((part): part is string => typeof part === 'string' && part.length > 0);
	let text = err.message;
	if (typeof e.code === 'string' && !text.includes(e.code)) text += ` (${e.code})`;
	return detail.length > 0 ? `${text}: ${detail.join(' ')}` : text;
}
