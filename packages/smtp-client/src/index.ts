/**
 * @owlat/smtp-client — an in-house SMTP client we fully control.
 *
 * This entry point re-exports the pure, socket-free core: the reply parser, the
 * structured {@link SmtpError} taxonomy, the streaming dot-stuffing encoder, and
 * the command serializers + EHLO capability parser — plus the connection engine
 * ({@link SmtpConnection.connect}), which drives the socket layer up through
 * EHLO — plus the transaction layer (AUTH, the MAIL/RCPT/DATA envelope, QUIT
 * teardown, and the {@link verify} / {@link sendMessage} convenience wrappers).
 */

export {
	type SmtpPhase,
	type SmtpTlsCause,
	type SmtpErrorInit,
	SmtpError,
	isSmtpError,
} from './errors';

export {
	type SmtpReply,
	parseReply,
	parseReplyLine,
	ReplyParser,
	isPositiveCompletion,
	isPositiveIntermediate,
} from './reply';

export { DotStuffEncoder, dotStuffMessage } from './dotStuff';

export {
	type EhloCapabilities,
	SmtpCommandInjectionError,
	serializeEhlo,
	serializeHelo,
	serializeMailFrom,
	serializeRcptTo,
	serializeData,
	serializeRset,
	serializeQuit,
	serializeStartTls,
	serializeNoop,
	serializeAuth,
	serializeAuthContinuation,
	parseEhloCapabilities,
	hasCapability,
} from './commands';

export {
	type SmtpConnectOptions,
	type SmtpTlsOptions,
	type SmtpTlsMode,
	type SmtpTimeouts,
	SmtpConnection,
} from './connection';

export {
	type SmtpAuthMechanism,
	type SmtpCredentials,
	type AuthenticateOptions,
	type RecipientVerdict,
	type EnvelopeOptions,
	type SendResult,
	type AuthConfig,
	type SendMessageOptions,
	type VerifyOptions,
	authenticate,
	sendEnvelope,
	quit,
	sendMessage,
	verify,
} from './transaction';
