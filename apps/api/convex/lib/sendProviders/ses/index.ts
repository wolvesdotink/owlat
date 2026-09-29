'use node';

/**
 * SES Send provider adapter (module).
 *
 * Per ADR-0020. Single-attempt `sendEmail` via the AWS SDK; failures are
 * classified by the SDK error's `name` first, then fall back to substring
 * matching for cases where the SDK throws untyped errors.
 *
 * Every send composes its own MIME with `@owlat/mail-message` (through the
 * shared `toComposeInput`, exactly as the SMTP and Mandrill adapters do) and
 * goes out through `SendRawEmailCommand`. One path carries the plain-text
 * part, the custom headers (List-Unsubscribe / List-Unsubscribe-Post for RFC
 * 8058 one-click unsubscribe, which `SendEmailCommand` would drop), the
 * attachments, a Message-ID and a Date. Header sanitising belongs to the
 * composer.
 *
 * `'use node'`: the composer returns a Node `Buffer`. The only production
 * importer is the `'use node'` `providers/composition.ts`.
 */

import { SendRawEmailCommand, type SESClient } from '@aws-sdk/client-ses';
import { composeMessage } from '@owlat/mail-message';
import { buildSesClient } from '../../emailProviders/sesIdentity';
import { withTimeout } from '../../inputGuards';
import {
	EmailErrorCode,
	httpStatusToErrorCode,
	type EmailSendAttempt,
	type EmailSendParams,
	type SendProviderModule,
	type SesExtras,
} from '../types';
import { isAmbiguousPostDispatchTimeout } from '../errors';
import { sendProviderCatalogEntry } from '../catalog';
import { toComposeInput } from '../composeInput';
import { transportEnvOptional, transportEnvRequired } from '../transportEnv';
import type { SendTransportRecord } from '../transports';

/**
 * Upper bound on a single SES send call. Once the request is on the wire, a
 * timeout is AMBIGUOUS: AWS may already have accepted (and delivered) it, but
 * the response was lost. The adapter only reports that as `AMBIGUOUS_TIMEOUT`;
 * `sendProviderDispatch` reads the catalog (no dedup, `unknown-on-timeout`) and
 * returns it terminal with `acceptanceUnknown`. See `sendEmail`.
 */
const SES_SEND_TIMEOUT_MS = 30_000;
const SES_SEND_TIMEOUT_MESSAGE = 'SES send timed out';

// One client per CONFIGURED TRANSPORT, not one per deployment: two `ses`
// transports carry different credential triples, so caching by kind would leak
// the first instance's credentials into the second one's sends.
const cachedClients = new Map<string, SESClient>();

function getSesClient(transport: SendTransportRecord): SESClient {
	const cached = cachedClients.get(transport.id);
	if (cached) return cached;
	// Shared client builder lives in sesIdentity.buildSesClient; cache the
	// result here so the send hot path doesn't re-read env / rebuild per send.
	const client = buildSesClient({
		region: transportEnvRequired(transport, 'AWS_SES_REGION'),
		accessKeyId: transportEnvRequired(transport, 'AWS_SES_ACCESS_KEY_ID'),
		secretAccessKey: transportEnvRequired(transport, 'AWS_SES_SECRET_ACCESS_KEY'),
	});
	cachedClients.set(transport.id, client);
	return client;
}

export const sesSendProvider: SendProviderModule<'ses'> = {
	kind: 'ses',
	retryDelays: sendProviderCatalogEntry('ses').retryDelays,

	/**
	 * SES takes NO per-send extras, stated rather than left to a missing method.
	 *
	 * Its two candidate knobs are both decided elsewhere: the envelope sender
	 * comes from the verified identity's configured custom MAIL FROM domain, not
	 * from a per-send address (hence the catalog's `supportsCustomReturnPath:
	 * 'no'`), and SES has no idempotency surface at all — no dedup header, no
	 * dedup on Configuration-Set tags. That is why the catalog declares
	 * `deduplicatesOnIdempotencyKey: false`, and so why `sendProviderDispatch`
	 * never retries an SES post-dispatch timeout.
	 */
	buildDispatchExtras(): SesExtras {
		return {};
	},

	async sendEmail(
		transport: SendTransportRecord,
		params: EmailSendParams,
		_extras?: SesExtras
	): Promise<EmailSendAttempt> {
		let client: SESClient;
		try {
			client = getSesClient(transport);
		} catch (error) {
			const errorMessage = error instanceof Error ? error.message : 'Unknown error';
			return {
				success: false,
				errorMessage,
				errorCode: EmailErrorCode.AUTH_FAILED,
			};
		}

		let raw: Buffer;
		try {
			raw = composeMessage(toComposeInput(params)).raw;
		} catch (error) {
			// A composition failure never touched the wire: classify it by its text,
			// the same way SMTP and Mandrill do.
			const errorMessage = error instanceof Error ? error.message : 'Unknown error';
			return { success: false, errorMessage, errorCode: this.categorizeError(errorMessage) };
		}

		try {
			// Tag every send with the Configuration Set (when configured) so SES
			// event-publishing attributes the resulting bounce/complaint/delivery
			// feedback back to this send. Undefined ⇒ the field is omitted.
			const configurationSetName = transportEnvOptional(transport, 'SES_CONFIGURATION_SET');
			const command = new SendRawEmailCommand({
				RawMessage: { Data: new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength) },
				...(configurationSetName ? { ConfigurationSetName: configurationSetName } : {}),
			});
			// Bound the send so a stuck socket becomes a deterministic timeout the
			// catch below reports as AMBIGUOUS_TIMEOUT (SES cannot dedup a retry).
			const response = await withTimeout(
				client.send(command),
				SES_SEND_TIMEOUT_MS,
				SES_SEND_TIMEOUT_MESSAGE
			);
			const messageId = response.MessageId;

			if (!messageId) {
				return {
					success: false,
					errorMessage: 'No message ID returned from SES',
					errorCode: EmailErrorCode.SERVER_ERROR,
				};
			}

			return { success: true, id: messageId };
		} catch (error) {
			const errorMessage = error instanceof Error ? error.message : 'Unknown error';
			const errorName = error instanceof Error ? error.name : undefined;
			// A post-dispatch timeout is AMBIGUOUS: SES may already have accepted
			// and delivered the message, but the response was lost. Report the fact;
			// `sendProviderDispatch` decides from the catalog that it is terminal and
			// stamps `acceptanceUnknown`. Explicit AWS 5xx responses
			// (ServiceUnavailable / InternalFailure) still map to the retryable
			// SERVER_ERROR via `categorizeError` because AWS did not accept those.
			if (isAmbiguousPostDispatchTimeout(errorName, errorMessage, SES_SEND_TIMEOUT_MESSAGE)) {
				return {
					success: false,
					errorMessage,
					errorCode: EmailErrorCode.AMBIGUOUS_TIMEOUT,
				};
			}
			return {
				success: false,
				errorMessage,
				errorCode: this.categorizeError(`${errorName ?? ''}: ${errorMessage}`),
			};
		}
	},

	/**
	 * Classify an SES error. The AWS SDK throws typed errors whose `name`
	 * carries the SES error code (e.g. `Throttling`, `MessageRejected`,
	 * `MailFromDomainNotVerified`). The dispatch helper passes
	 * `${error.name}: ${error.message}` so this method matches on either.
	 */
	categorizeError(message: string, httpStatus?: number): EmailErrorCode {
		if (httpStatus !== undefined) {
			const byStatus = httpStatusToErrorCode(httpStatus);
			if (byStatus !== undefined) return byStatus;
		}

		const lower = message.toLowerCase();

		if (
			lower.includes('throttling') ||
			lower.includes('throttl') ||
			lower.includes('toomanyrequests') ||
			lower.includes('too many requests') ||
			lower.includes('rate exceeded') ||
			lower.includes('sendingpausedexception')
		) {
			return EmailErrorCode.RATE_LIMIT;
		}
		if (
			lower.includes('serviceunavailable') ||
			lower.includes('internalfailure') ||
			lower.includes('internal error') ||
			lower.includes('timeout')
		) {
			return EmailErrorCode.SERVER_ERROR;
		}
		if (
			lower.includes('mailfromdomainnotverified') ||
			lower.includes('verificationmissing') ||
			lower.includes('configurationdoesnotexist') ||
			lower.includes('not verified')
		) {
			return EmailErrorCode.INVALID_SENDER;
		}
		if (
			lower.includes('accountsuspended') ||
			lower.includes('signaturedoesnotmatch') ||
			lower.includes('invalidclienttokenid') ||
			lower.includes('unrecognizedclient')
		) {
			return EmailErrorCode.AUTH_FAILED;
		}
		if (
			lower.includes('messagerejected') ||
			lower.includes('content rejected') ||
			lower.includes('spam')
		) {
			return EmailErrorCode.CONTENT_REJECTED;
		}
		if (
			lower.includes('invalidparameter') &&
			(lower.includes('destination') || lower.includes('recipient'))
		) {
			return EmailErrorCode.INVALID_RECIPIENT;
		}

		return EmailErrorCode.UNKNOWN;
	},
};

// Exported for tests that need to bypass the lazy-init cache between cases.
export function _resetSesClientCacheForTests(): void {
	cachedClients.clear();
}
