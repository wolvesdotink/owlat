/**
 * Tagged replies shared across IMAP command modules.
 */

/**
 * The tagged reply for a command that failed on the server side (a
 * backend call threw). RFC 3501 reserves BAD for client errors such as
 * a syntax error, so a server fault is a NO, and the RFC 5530
 * `[UNAVAILABLE]` code tells the client the failure is temporary and the
 * command may be retried. `label` is the command as the client sent it,
 * e.g. `UID STORE`.
 */
export function serverFailure(tag: string, label: string): string {
	return `${tag} NO [UNAVAILABLE] ${label} failed`;
}
