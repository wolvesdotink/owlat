/**
 * The backend↔IMAP-server wire contract version (ADR-0063).
 *
 * The IMAP server (apps/imap) calls backend functions directly with an admin
 * key (`fn` in apps/imap/src/convex.ts). Their arguments and results are a
 * contract between two separately deployed images: the backend is upgraded
 * first and the IMAP container after it, so for a while, and for as long as
 * an operator lets it, an older IMAP server calls newer functions. The backend
 * keeps every compatibility path that older server needs until it knows no
 * such server is left.
 *
 * Compatibility is an integer, checked once at the IMAP server's startup
 * handshake (`mail/imap/serverRegistry:report`) and again every few minutes,
 * not a comparison of release strings. Release strings say nothing about the
 * contract, `dev` builds have none, and the backend does not reliably know its
 * own release.
 *
 * Bump rules:
 *
 * - Bump `IMAP_WIRE_VERSION` in the PR that changes the contract: a function
 *   the IMAP server calls gains, loses or changes an argument or a result
 *   field, or the IMAP server starts calling a function the previous backend
 *   does not have. The backend and the IMAP server ship from the same commit,
 *   so both sides move together.
 * - Raise `IMAP_WIRE_MIN_SUPPORTED` only in the PR that removes a compatibility
 *   path, and only to a version every IMAP release inside the supported skew
 *   window speaks (the IMAP server may lag the backend by one release). The PR
 *   cites `npx convex run mail/imap/serverRegistry:status`. A reporting IMAP
 *   server below the minimum does not start; the backend refuses logins and
 *   gated calls from any server below it, including those that never report
 *   (`assertImapWireSupported`). A function about to be contracted takes an
 *   optional `imapWireVersion` one release ahead so the removing PR can gate it.
 *
 * Dependency-free on purpose: the api, imap and web images all read it.
 */

/** The contract this build speaks. Version 0 is the release before reporting (v0.6.7 and older). */
export const IMAP_WIRE_VERSION = 1;

/** The oldest IMAP server contract the backend still serves. */
export const IMAP_WIRE_MIN_SUPPORTED = 0;

/** What an IMAP server that never reports (v0.6.7 and older) counts as. */
export const IMAP_WIRE_LEGACY = 0;

/**
 * How one IMAP server's contract relates to the backend's:
 * - `current`: the same contract.
 * - `supported`: older, still served through a compatibility path.
 * - `unsupported`: older than the backend serves; it refuses to start.
 * - `ahead`: newer than the backend; it waits for the backend update.
 */
export type ImapWireVerdict = 'current' | 'supported' | 'unsupported' | 'ahead';

export function imapWireVerdict(
	serverWireVersion: number,
	backendWireVersion: number = IMAP_WIRE_VERSION,
	minSupportedWireVersion: number = IMAP_WIRE_MIN_SUPPORTED
): ImapWireVerdict {
	if (serverWireVersion > backendWireVersion) return 'ahead';
	if (serverWireVersion === backendWireVersion) return 'current';
	if (serverWireVersion >= minSupportedWireVersion) return 'supported';
	return 'unsupported';
}
