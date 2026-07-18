/**
 * The MAIL/RCPT/DATA envelope of the in-house SMTP client.
 *
 * Sits on top of the {@link SmtpConnection} engine and drives one mail
 * transaction: MAIL FROM, a per-recipient RCPT TO verdict, the DATA handshake and
 * the dot-stuffed body. Two dispatch paths produce behaviourally identical
 * results — the v1 sequential command/reply loop, and the RFC 2920 PIPELINING
 * batch (MAIL + every RCPT + DATA in one write, replies read back in order). The
 * choice is strictly capability-gated (or forced via {@link EnvelopeOptions.pipelining});
 * pipelining changes only timing, never the verdicts or the phase-tagged taxonomy.
 *
 * Every failure is a phase-tagged {@link SmtpError}: a drop during or after the
 * body surfaces in phase `data`/`data-final` — the double-delivery-ambiguous region
 * the MTA retry taxonomy must never auto-retry — while a reject before the body is
 * safely retryable. {@link errorFromReply} is the single constructor for these and
 * is shared with the AUTH / RSET layers in `transaction.ts`.
 */

import { serializeMailFrom, serializeRcptTo, serializeData, hasCapability } from './commands';
import { SmtpConnection } from './connection';
import { SmtpError, type SmtpErrorInit, type SmtpPhase } from './errors';
import { dotStuffMessage } from './dotStuff';
import { isPositiveCompletion, isPositiveIntermediate, type SmtpReply } from './reply';

/**
 * The single constructor for a phase-tagged {@link SmtpError} carrying a server
 * reply's code. Pass the `reply` (or a `{ code, enhancedCode }` view of a
 * per-recipient verdict) to copy its `replyCode`/`enhancedCode`; omit it for a
 * client-side refusal that carries no reply code.
 */
export function errorFromReply(
	phase: SmtpPhase,
	message: string,
	secured: boolean,
	reply?: { code: number; enhancedCode?: string }
): SmtpError {
	const init: SmtpErrorInit = { phase, message, secured };
	if (reply !== undefined) {
		init.replyCode = reply.code;
		if (reply.enhancedCode !== undefined) {
			init.enhancedCode = reply.enhancedCode;
		}
	}
	return new SmtpError(init);
}

// ── Envelope + DATA ───────────────────────────────────────────────────────────

/** The verdict the server returned for a single recipient's RCPT TO. */
export interface RecipientVerdict {
	/** The recipient mailbox exactly as offered in RCPT TO. */
	recipient: string;
	/** `true` iff the server returned a 2xx completion for this recipient. */
	accepted: boolean;
	/** The three-digit reply code the server returned. */
	replyCode: number;
	/** RFC 3463 enhanced status code, when the server supplied one. */
	enhancedCode?: string;
	/** The reply text (for logs — never classified against). */
	message: string;
}

/**
 * How the MAIL/RCPT/DATA envelope commands are dispatched.
 *
 *  - `'auto'` (default): pipeline the envelope commands (RFC 2920) iff the server
 *    advertised `PIPELINING` in EHLO, else run the sequential command/reply path.
 *  - `'always'`: force the pipelined path regardless of the advertisement
 *    (deterministic tests / a peer known to accept it).
 *  - `'never'`: force the sequential path regardless of the advertisement.
 *
 * Pipelining changes only timing: the per-recipient verdicts and the phase-tagged
 * {@link SmtpError} taxonomy are identical to the sequential path.
 */
export type PipeliningMode = 'auto' | 'always' | 'never';

export interface EnvelopeOptions {
	/** Return-path mailbox. The empty string serializes the null sender `<>`. */
	from: string;
	/** Recipient mailboxes. At least one must be accepted for DATA to run. */
	to: readonly string[];
	/** The composed message bytes (already RFC 5322; dot-stuffed on the wire). */
	data: Buffer | string;
	/** Extra ESMTP params on MAIL FROM, appended after an auto SIZE. */
	mailParams?: readonly string[];
	/** Extra ESMTP params on every RCPT TO (e.g. `NOTIFY=NEVER`). */
	rcptParams?: readonly string[];
	/**
	 * PIPELINING (RFC 2920) override. Defaults to `'auto'` — pipeline iff the server
	 * advertised the capability. `'always'`/`'never'` force the path. Timing only:
	 * verdicts and phase-tagged errors are indistinguishable from sequential mode.
	 */
	pipelining?: PipeliningMode;
}

/** The outcome of a completed DATA transaction. */
export interface SendResult {
	/** Recipients the server accepted (RCPT 2xx). Never empty on success. */
	accepted: RecipientVerdict[];
	/** Recipients the server rejected, with their reply codes. */
	rejected: RecipientVerdict[];
	/** The final reply that acknowledged the message (2xx). */
	response: SmtpReply;
}

/** The MAIL FROM + RCPT params + body derived once, shared by both dispatch paths. */
interface PreparedEnvelope {
	/** The message body as bytes (dot-stuffed only when it reaches the wire). */
	body: Buffer;
	/** MAIL FROM ESMTP params (auto `SIZE` + caller extras). */
	mailParams: string[];
	/** RCPT TO ESMTP params applied to every recipient. */
	rcptParams: readonly string[];
}

/**
 * Derive the body bytes and the MAIL/RCPT parameter lists once, so the sequential
 * and pipelined paths serialize byte-identical commands (SIZE included) — the only
 * difference between them is write batching, never the command content.
 */
function prepareEnvelope(
	conn: SmtpConnection,
	options: EnvelopeOptions,
	smtpUtf8: boolean
): PreparedEnvelope {
	const body = typeof options.data === 'string' ? Buffer.from(options.data, 'utf8') : options.data;
	// MAIL FROM SIZE (RFC 1870) when the server advertised it. The declared size is
	// the un-stuffed message length — what the server budgets against.
	const mailParams: string[] = [];
	if (hasCapability(conn.capabilities, 'SIZE')) {
		mailParams.push(`SIZE=${body.length}`);
	}
	// SMTPUTF8 (RFC 6531 §3.4) rides on MAIL FROM — and ONLY there — when the
	// envelope carries a non-ASCII mailbox and the server advertised the extension.
	// The caller-computed `smtpUtf8` gate already proved the server advertised it
	// (the not-advertised case failed closed before we reach here), so appending the
	// keyword can never smuggle an unsupported param past the peer.
	if (smtpUtf8) {
		mailParams.push('SMTPUTF8');
	}
	if (options.mailParams !== undefined) {
		mailParams.push(...options.mailParams);
	}
	return { body, mailParams, rcptParams: options.rcptParams ?? [] };
}

// eslint-disable-next-line no-control-regex
const NON_ASCII = /[^\x00-\x7F]/;

/**
 * Does this envelope carry a non-ASCII (RFC 6531 EAI) address — a return path or
 * recipient with ANY non-ASCII byte, whether in the local-part OR the domain? Such
 * an address can only cross the wire over an `SMTPUTF8` transaction, so it is the
 * fail-closed gate: if the server did not advertise SMTPUTF8, {@link sendEnvelope}
 * refuses rather than emitting raw UTF-8 with no keyword (an RFC 6531 violation and
 * a mojibake/misdelivery vector against a non-SMTPUTF8 peer).
 *
 * The check spans the WHOLE address on purpose. A non-ASCII local-part has no ASCII
 * downgrade at all; a non-ASCII (U-label) domain has a lossless punycode downgrade,
 * but this package does NOT perform that downgrade — so a domain still carrying
 * U-labels when it reaches the client genuinely needs SMTPUTF8, and keying only on
 * the local-part would fail OPEN (write the raw UTF-8 domain with no keyword). An
 * already-punycoded domain is pure ASCII (`xn--…`), so it never trips this and keeps
 * sending normally. Read structurally from the envelope bytes — never a message-text
 * sniff.
 */
export function envelopeRequiresSmtpUtf8(options: EnvelopeOptions): boolean {
	if (NON_ASCII.test(options.from)) {
		return true;
	}
	for (const recipient of options.to) {
		if (NON_ASCII.test(recipient)) {
			return true;
		}
	}
	return false;
}

function shouldPipeline(mode: PipeliningMode | undefined, advertised: boolean): boolean {
	if (mode === 'always') {
		return true;
	}
	if (mode === 'never') {
		return false;
	}
	// 'auto' (or unset): strictly capability-gated on the server's advertisement.
	return advertised;
}

/**
 * Run a MAIL/RCPT/DATA transaction on an open, authenticated (if needed)
 * connection. Collects a per-recipient RCPT verdict and proceeds to DATA as long
 * as ≥1 recipient was accepted; if none were, throws in phase `rcpt` (safely
 * retryable). A drop during or after the body surfaces in phase `data`/
 * `data-final` — the ambiguous, never-auto-retried region.
 *
 * When the server advertised `PIPELINING` (RFC 2920) — or the caller forces it via
 * `options.pipelining` — MAIL FROM, every RCPT TO and DATA are written in one batch
 * and their replies read back in order; otherwise the sequential command/reply path
 * runs. The two paths are behaviourally indistinguishable: same verdicts, same
 * phase-tagged errors, same body on the wire — pipelining only changes timing.
 */
export async function sendEnvelope(
	conn: SmtpConnection,
	options: EnvelopeOptions
): Promise<SendResult> {
	if (options.to.length === 0) {
		// Nothing to deliver to — refuse BEFORE MAIL FROM reaches the wire. A
		// client-side refusal, so no reply code; phase `rcpt` keeps it in the safely
		// retryable region.
		throw errorFromReply('rcpt', 'no recipients supplied', conn.secured);
	}

	// SMTPUTF8 / EAI (RFC 6531): an internationalized envelope needs the extension.
	// If the server advertised it we tag MAIL FROM; if it did NOT, we FAIL CLOSED
	// here — before any byte reaches the wire — because a non-ASCII address (local-part
	// OR an un-punycoded U-label domain) cannot be safely emitted without the keyword,
	// and silently writing raw UTF-8 would misdeliver/mojibake. This is a permanent
	// condition (`clientRefusal: 'smtputf8-unavailable'`), never retried.
	const smtpUtf8 = envelopeRequiresSmtpUtf8(options);
	if (smtpUtf8 && !conn.capabilities.smtpUtf8) {
		throw new SmtpError({
			phase: 'mail',
			message:
				'server does not advertise SMTPUTF8 (RFC 6531); refusing to send an internationalized ' +
				'(non-ASCII) envelope address — there is no safe ASCII form for a UTF-8 mailbox or domain',
			secured: conn.secured,
			clientRefusal: 'smtputf8-unavailable',
		});
	}

	const prepared = prepareEnvelope(conn, options, smtpUtf8);
	if (shouldPipeline(options.pipelining, conn.capabilities.pipelining)) {
		return sendEnvelopePipelined(conn, options, prepared);
	}
	return sendEnvelopeSequential(conn, options, prepared);
}

/** The v1 sequential command/reply envelope — unchanged when PIPELINING is absent. */
async function sendEnvelopeSequential(
	conn: SmtpConnection,
	options: EnvelopeOptions,
	prepared: PreparedEnvelope
): Promise<SendResult> {
	const mailReply = await conn.command(
		serializeMailFrom(options.from, prepared.mailParams),
		'mail'
	);
	assertCompletion(mailReply, 'mail', conn.secured);

	// RCPT TO — one per recipient, collecting verdicts.
	const accepted: RecipientVerdict[] = [];
	const rejected: RecipientVerdict[] = [];
	for (const recipient of options.to) {
		const reply = await conn.command(serializeRcptTo(recipient, prepared.rcptParams), 'rcpt');
		partitionVerdict(toVerdict(recipient, reply), accepted, rejected);
	}
	if (accepted.length === 0) {
		throw everyRecipientRejected(conn, rejected);
	}

	// DATA — the 354 intermediate handshake (phase `data`).
	const dataReply = await conn.command(serializeData(), 'data');
	return completeData(conn, prepared, dataReply, accepted, rejected);
}

/**
 * The pipelined (RFC 2920) envelope: MAIL FROM + every RCPT TO + DATA go out in one
 * write, and their replies are read back in command order. The body is NEVER
 * pipelined — the client waits for DATA's 354 before streaming it (RFC 2920 §3.1),
 * exactly like the sequential path, so the double-delivery-ambiguous `data-final`
 * region is identical.
 */
async function sendEnvelopePipelined(
	conn: SmtpConnection,
	options: EnvelopeOptions,
	prepared: PreparedEnvelope
): Promise<SendResult> {
	const batch = [
		serializeMailFrom(options.from, prepared.mailParams),
		...options.to.map((recipient) => serializeRcptTo(recipient, prepared.rcptParams)),
		serializeData(),
	];
	conn.writePipeline(batch, 'mail');

	// Replies stream back strictly in command order: MAIL, RCPT×N, DATA. The reply
	// reader buffers whatever the peer sends — one packet for the whole batch, one
	// packet per line, or bytes split mid-reply — so reading them one at a time
	// re-aligns the batch regardless of TCP framing.
	const mailReply = await conn.readReply('mail', conn.commandTimeoutMs);
	if (!isPositiveCompletion(mailReply.code)) {
		// A rejected MAIL FROM aborts the batch. The RCPTs + DATA are already on the
		// wire, so drain their replies (a compliant server answers each with a 503)
		// to leave the reply stream aligned, then throw in phase `mail` — the exact
		// verdict the sequential path returns for a reject-at-MAIL.
		const desynced = await drainPipelinedReplies(conn, options.to.length + 1);
		if (desynced) {
			// A non-compliant server answered the aborted batch's DATA with 354 and
			// is now in DATA state: its next read is message body, not a command
			// reply. Close the socket so the reuse layer (X1) can never park a
			// desynced connection whose next job's RSET is swallowed as body.
			conn.close();
		}
		throw errorFromReply(
			'mail',
			`server rejected mail with ${mailReply.code}`,
			conn.secured,
			mailReply
		);
	}

	const accepted: RecipientVerdict[] = [];
	const rejected: RecipientVerdict[] = [];
	for (const recipient of options.to) {
		const reply = await conn.readReply('rcpt', conn.commandTimeoutMs);
		partitionVerdict(toVerdict(recipient, reply), accepted, rejected);
	}

	// DATA's reply is next in the stream whether or not any recipient was accepted;
	// read it so the reply stream stays aligned even on the all-rejected abort.
	const dataReply = await conn.readReply('data', conn.commandTimeoutMs);

	if (accepted.length === 0) {
		if (isPositiveIntermediate(dataReply.code)) {
			// Every recipient was rejected, yet a non-compliant server still answered
			// the pipelined DATA with 354 and entered DATA state. The client is about
			// to throw a clean pre-DATA rejection; close the desynced socket so the
			// reuse layer can never park it (its next read is body, not a reply).
			conn.close();
		}
		throw everyRecipientRejected(conn, rejected);
	}

	return completeData(conn, prepared, dataReply, accepted, rejected);
}

function partitionVerdict(
	verdict: RecipientVerdict,
	accepted: RecipientVerdict[],
	rejected: RecipientVerdict[]
): void {
	if (verdict.accepted) {
		accepted.push(verdict);
	} else {
		rejected.push(verdict);
	}
}

/**
 * The shared all-recipients-rejected error: phase `rcpt` (pre-DATA, safely
 * retryable) carrying the last rejection's code. Identical in both dispatch paths.
 */
function everyRecipientRejected(conn: SmtpConnection, rejected: RecipientVerdict[]): SmtpError {
	const last = rejected[rejected.length - 1];
	return errorFromReply(
		'rcpt',
		'every recipient was rejected',
		conn.secured,
		last === undefined ? undefined : { code: last.replyCode, enhancedCode: last.enhancedCode }
	);
}

/**
 * The shared DATA tail: validate the 354 handshake, stream the dot-stuffed body +
 * terminator, then await the final reply. Both the write and the wait live in phase
 * `data-final` — the double-delivery-ambiguous region the retry taxonomy must never
 * auto-retry. Identical for the sequential and pipelined paths.
 */
async function completeData(
	conn: SmtpConnection,
	prepared: PreparedEnvelope,
	dataReply: SmtpReply,
	accepted: RecipientVerdict[],
	rejected: RecipientVerdict[]
): Promise<SendResult> {
	if (!isPositiveIntermediate(dataReply.code)) {
		throw errorFromReply(
			'data',
			`server rejected data with ${dataReply.code}`,
			conn.secured,
			dataReply
		);
	}
	// The socket-lifecycle mechanics live on SmtpConnection, which owns the socket.
	const dataDeadline = Date.now() + conn.dataTimeoutMs;
	try {
		await conn.writePayload(dotStuffMessage(prepared.body), 'data-final', conn.dataTimeoutMs);
		// Writing and awaiting the acknowledgement share one DATA-phase budget. A
		// peer cannot consume the full timeout with backpressure and then receive a
		// fresh full timeout for its final reply.
		const replyBudget = Math.max(1, dataDeadline - Date.now());
		const finalReply = await conn.readReply('data-final', replyBudget);
		assertCompletion(finalReply, 'data-final', conn.secured);
		return { accepted, rejected, response: finalReply };
	} catch (err) {
		// A server can write a definitive final verdict (e.g. `554 5.7.1 …`) DURING the
		// body stream and immediately slam the socket: the reply lands in the reader's
		// queue, then the FIN poisons the reader, so writePayload/readReply reject with
		// a generic close error carrying NO replyCode — the permanent 5xx would be lost
		// and a hard bounce misclassified as an ambiguous data-phase failure. Only when
		// the failure is such a reply-less wire error do we look for a complete reply the
		// peer already committed and surface THAT verdict instead. A failure that already
		// carries a replyCode (a real 5xx we read cleanly) is left untouched, and the
		// anti-desync posture for the normal case is unchanged.
		const buffered = isReplylessWireError(err) ? conn.takeBufferedReply() : undefined;
		if (buffered !== undefined) {
			if (isPositiveCompletion(buffered.code)) {
				return { accepted, rejected, response: buffered };
			}
			throw errorFromReply(
				'data-final',
				`server rejected data with ${buffered.code}`,
				conn.secured,
				buffered
			);
		}
		throw err;
	}
}

/**
 * `true` for a data-phase failure that carries no server reply code — a socket
 * close/error/timeout surfaced as a generic {@link SmtpError}. Such a failure is the
 * only case where a queued-but-unread final reply may still hold the real verdict.
 */
function isReplylessWireError(err: unknown): boolean {
	return err instanceof SmtpError && err.replyCode === undefined;
}

/**
 * Best-effort drain of the replies to an aborted pipelined batch (the RCPTs + DATA
 * that followed a rejected MAIL FROM). A compliant server answers each with a 503;
 * a server that closes the socket instead simply ends the drain early. The caller
 * is about to throw and the socket will be discarded, so a swallowed error here is
 * benign — the drain only tidies a socket that MIGHT still be reusable.
 *
 * Returns `true` iff any drained reply was a positive intermediate (354): a
 * non-compliant server answered the aborted batch's DATA and is now in DATA state,
 * so the socket is desynced and the caller must close it rather than park it.
 */
async function drainPipelinedReplies(conn: SmtpConnection, count: number): Promise<boolean> {
	let desynced = false;
	for (let i = 0; i < count; i++) {
		try {
			const reply = await conn.readReply('mail', conn.commandTimeoutMs);
			if (isPositiveIntermediate(reply.code)) {
				desynced = true;
			}
		} catch {
			return desynced;
		}
	}
	return desynced;
}

function toVerdict(recipient: string, reply: SmtpReply): RecipientVerdict {
	const verdict: RecipientVerdict = {
		recipient,
		accepted: isPositiveCompletion(reply.code),
		replyCode: reply.code,
		message: reply.text,
	};
	if (reply.enhancedCode !== undefined) {
		verdict.enhancedCode = reply.enhancedCode;
	}
	return verdict;
}

function assertCompletion(reply: SmtpReply, phase: 'mail' | 'data-final', secured: boolean): void {
	if (isPositiveCompletion(reply.code)) {
		return;
	}
	throw errorFromReply(phase, `server rejected ${phase} with ${reply.code}`, secured, reply);
}
