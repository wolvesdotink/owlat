/**
 * @owlat/smtp-listener
 *
 * In-house SMTP listener that replaces `smtp-server` on Owlat's inbound path
 * (port-25 MX + 587/465 submission). L1 ships the raw-`net` command loop, the
 * load-bearing byte budget (a port of `apps/mta/src/lib/dataStream.ts`), SMTP
 * dot-decoding, byte-exact reply serialization, and the timeout skeleton. L2
 * adds TLS/AUTH; L3 adds the hostile-input hardening and `smtp-server` parity
 * differential tests.
 */

export { createSmtpListener, type SmtpListener } from './server.js';
export { serializeReply, replyBytes, Reply, SmtpReplyError } from './reply.js';
export {
	ByteBudget,
	collectDataStream,
	messageTooLargeError,
	type BudgetVerdict,
} from './budget.js';
export { dotDecode } from './dotDecode.js';
export { SmtpCommandReader, parseCommand, parseAddressCommand } from './reader.js';
export { runCommandLoop, type ResolvedListenerConfig } from './commandLoop.js';
export { resolveConfig, handleConnection } from './session.js';
export {
	DEFAULT_SMTP_CIPHERS,
	resolveTlsConfig,
	upgradeTls,
	type SmtpTlsConfig,
	type ResolvedTlsConfig,
	type SmtpSniCallback,
} from './tls.js';
export {
	performAuth,
	type SaslMechanism,
	type SmtpAuthConfig,
	type SmtpAuthCredentials,
	type SmtpAuthOutcome,
	type AuthExchangeResult,
} from './auth.js';
export type {
	SmtpReply,
	SmtpAddress,
	SmtpSession,
	SmtpTimeouts,
	SmtpHandlerResult,
	SmtpListenerOptions,
} from './types.js';
