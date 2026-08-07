/**
 * The `send-provider` template's THREE EXECUTABLE HALVES, as emitted source.
 *
 * Split out of `./scaffoldSendProvider` at the repository's ~500 LOC ratchet, and
 * along the seam the bundle itself has: this module emits the code that RUNS at a
 * provider integration's three boundaries (a send, an inbound delivery, an
 * identity call), while its sibling emits the DECLARATION those three are reached
 * through. The declaration module stays the one that assembles the file set, so
 * "what does the template write?" is still answered in one place.
 *
 * The vendor-specific decisions each of these leaves to an author are marked
 * `TODO` at the line they belong on; everything else is the part of a provider
 * integration that is the same for every vendor. See the sibling's header for why
 * they are `fetch`-shaped rather than stubs that throw.
 */

import type { SendProviderNames } from './scaffoldSendProvider';
import { SEND_PROVIDER_ENV_CONSTANTS } from './scaffoldSendProvider';

export function transportSource(names: SendProviderNames): string {
	const c = SEND_PROVIDER_ENV_CONSTANTS;
	return `/**
 * ${names.id} — the SEND half of the bundle.
 *
 * ONE NETWORK ATTEMPT PER CALL. Owlat owns authorization, retries, health,
 * breakers and audit; this module puts exactly one request on the wire and
 * reports the outcome in the kit's typed vocabulary. Do not retry in here — a
 * retry the host cannot see is a message it cannot account for.
 *
 * CREDENTIALS COME FROM \`config\`, NEVER FROM \`process.env\`. An environment read
 * resolves the DEPLOYMENT-DEFAULT instance's variables whichever transport id the
 * send was addressed to, so \`${names.kind}#eu\` would go out
 * on the default instance's key — the silent credential borrow named instances
 * exist to prevent.
 */

import type {
	PluginSendAttempt,
	PluginSendDispatchContext,
	PluginSendTransportConfig,
	PluginSendTransportModule,
	PluginSendTransportParams,
} from '@owlat/plugin-kit';
// The names the MANIFEST declares, from the one module that declares them.
import { ${c.apiKey}, ${c.region} } from '../envNames';

/** TODO: your provider's send endpoint. */
const SEND_ENDPOINT = 'https://api.${names.id}.example/v1/messages';

/** This transport's own extras — whatever your API accepts per message. */
export interface Extras {
	readonly campaignTag?: string;
}

/**
 * Map one HTTP status onto the host's retry semantics. Getting this wrong is the
 * most expensive mistake in a provider integration: a 429 read as terminal drops
 * a message a retry would have delivered, and a permanent rejection read as
 * retryable burns the whole retry budget on a send that can never succeed.
 */
function failureFor(status: number): PluginSendAttempt {
	if (status === 401 || status === 403) return { success: false, code: 'authentication_failed' };
	if (status === 422) return { success: false, code: 'invalid_recipient' };
	if (status === 429) return { success: false, code: 'rate_limited' };
	// Transient by definition, and both are 4xx: a request that timed out and one
	// refused for arriving too early are the retryable half of the client range.
	if (status === 408 || status === 425) return { success: false, code: 'temporary_failure' };
	if (status >= 500) return { success: false, code: 'temporary_failure' };
	// TODO: any other status your provider uses for a TRANSIENT condition belongs
	// above this line. What falls through here is terminal — the host will not try
	// it again.
	return { success: false, code: 'content_rejected' };
}

export const ${names.camel}Transport: PluginSendTransportModule<Extras> = {
	/**
	 * THE SOLE UNKNOWN-INPUT BOUNDARY. Anything that is not this transport's own
	 * extras shape is REFUSED rather than coerced — including the host's
	 * re-validation of what \`buildDispatchExtras\` returned, which passes back
	 * through here before \`send\` is handed it.
	 */
	parseExtras(input: unknown): Extras {
		if (input === undefined || input === null) return {};
		if (typeof input !== 'object') {
			throw new TypeError('${names.id}: extras must be an object');
		}
		const tag = (input as Record<string, unknown>)['campaignTag'];
		if (tag === undefined) return {};
		if (typeof tag !== 'string') {
			throw new TypeError('${names.id}: campaignTag must be a string');
		}
		return { campaignTag: tag };
	},

	async send(
		params: PluginSendTransportParams,
		extras: Extras,
		config: PluginSendTransportConfig
	): Promise<PluginSendAttempt> {
		const apiKey = config.env[${c.apiKey}];
		// The host fails the attempt before \`send\` runs when a REQUIRED variable is
		// unset, so this is defence in depth rather than the gate.
		if (!apiKey) return { success: false, code: 'authentication_failed' };

		let response: Response;
		try {
			// TODO: your provider's request shape. \`params.attachments\` carries raw
			// bytes; encode them however your API expects.
			response = await fetch(SEND_ENDPOINT, {
				method: 'POST',
				headers: {
					authorization: \`Bearer \${apiKey}\`,
					'content-type': 'application/json',
				},
				body: JSON.stringify({
					to: params.to,
					from: params.from,
					subject: params.subject,
					html: params.html,
					text: params.text,
					reply_to: params.replyTo,
					headers: params.headers,
					region: config.env[${c.region}],
					tag: extras.campaignTag,
				}),
			});
		} catch {
			// A connection that never completed is AMBIGUOUS, not a refusal: the
			// request may have been accepted. Say so, so the host can decide.
			return { success: false, code: 'ambiguous_timeout' };
		}

		if (!response.ok) return failureFor(response.status);

		// TODO: your provider's response shape. The declared \`messageIdSource\` is
		// \`provider\`, so this id is what every feedback event is joined on.
		const body = (await response.json()) as { readonly id?: unknown };
		if (typeof body.id !== 'string' || body.id.length === 0) {
			return { success: false, code: 'unknown' };
		}
		return { success: true, id: body.id };
	},

	/**
	 * Turn one governed send's facts into this transport's extras. PURE AND
	 * SYNCHRONOUS BY CONTRACT — no I/O, no clock, no environment — so the hot send
	 * path grows no round trip. A throw yields no extras and the send proceeds
	 * without them.
	 */
	buildDispatchExtras(context: PluginSendDispatchContext): unknown {
		return { campaignTag: context.messageType };
	},
};
`;
}

export function webhookSource(names: SendProviderNames): string {
	return `/**
 * ${names.id} — the FEEDBACK half of the bundle.
 *
 * PARSE ONLY, and that is the contract's security thesis. By the time this runs
 * the host has already recomputed the declared HMAC over \`<timestamp>.<rawBody>\`
 * in constant time, bounded the timestamp's age against the declared tolerance,
 * and refused a delivery it has already accepted. So \`rawBody\` is authentic
 * bytes and this module's whole job is turning your provider's wire shape into
 * the four feedback facts Owlat acts on.
 *
 * RETURN THE EMPTY ARRAY for a console verification ping and for event kinds
 * Owlat does not consume — a 400 would make the provider redeliver them forever.
 * THROW on a body you cannot read; the route answers 400 and dispatches nothing.
 *
 * ISOLATE-SAFE: no Node builtins. The HTTP router runs this module.
 */

import type {
	PluginSendTransportWebhookModule,
	PluginWebhookFeedbackEvent,
} from '@owlat/plugin-kit';

/** TODO: your provider's event shape. */
interface WireEvent {
	readonly type?: unknown;
	readonly message_id?: unknown;
	readonly timestamp?: unknown;
	readonly recipient?: unknown;
	readonly reason?: unknown;
}

function readString(value: unknown): string | undefined {
	return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/**
 * The event's time, in EPOCH MILLISECONDS.
 *
 * TODO: convert your provider's timestamp here. The host refuses any value
 * outside [now − 1 year, now + 1 day] and fails the WHOLE batch when it does, so
 * a provider that reports epoch SECONDS (many do) needs \`* 1_000\` on this line —
 * a package whose own suite is green and whose every delivery is refused in
 * production is the failure this line exists to prevent.
 *
 * READ ONLY FOR KINDS THIS MODULE CONSUMES, which is why it is a function rather
 * than a line at the top of \`toFeedbackEvent\`: an engagement event Owlat ignores
 * may name its time field differently or omit it, and a throw there would 400 the
 * whole batch — taking the delivery and bounce events beside it down, and leaving
 * the provider redelivering the body forever.
 */
function readAt(raw: WireEvent): number {
	const at = typeof raw.timestamp === 'number' ? raw.timestamp : Number.NaN;
	if (!Number.isFinite(at)) {
		throw new TypeError('${names.id}: event carries no timestamp');
	}
	return at;
}

/** TODO: map your provider's event kinds onto the four facts Owlat records. */
function toFeedbackEvent(raw: WireEvent): PluginWebhookFeedbackEvent | null {
	const id = readString(raw.message_id);
	const recipient = readString(raw.recipient);
	const reason = readString(raw.reason);
	switch (raw.type) {
		case 'delivered':
			if (!id) throw new TypeError('${names.id}: delivery carries no message id');
			return {
				kind: 'delivered',
				providerMessageId: id,
				at: readAt(raw),
				...(recipient === undefined ? {} : { recipient }),
			};
		case 'hard_bounce':
		case 'soft_bounce':
			if (!id) throw new TypeError('${names.id}: bounce carries no message id');
			return {
				kind: 'bounced',
				providerMessageId: id,
				at: readAt(raw),
				bounceType: raw.type === 'hard_bounce' ? 'hard' : 'soft',
				...(reason === undefined ? {} : { bounceMessage: reason }),
			};
		case 'complaint':
			// The one report that may legitimately arrive redacted (RFC 5965 §3.2),
			// so it is allowed to name only the address — but not NEITHER: a report
			// naming no message and no recipient is a fact about nobody, and the host
			// refuses the whole batch for it. Say so here, where the wire shape is
			// understood, rather than letting a host-side message describe it.
			if (id === undefined && recipient === undefined) {
				throw new TypeError('${names.id}: complaint names no message or recipient');
			}
			return {
				kind: 'complained',
				at: readAt(raw),
				...(id === undefined ? {} : { providerMessageId: id }),
				...(recipient === undefined ? {} : { recipient }),
			};
		case 'deferred':
			if (!id) throw new TypeError('${names.id}: deferral carries no message id');
			return {
				kind: 'deferred',
				providerMessageId: id,
				at: readAt(raw),
				...(reason === undefined ? {} : { reason }),
			};
		default:
			// An event kind this integration does not consume. Acknowledged, not
			// refused — and reached before anything about the event is validated, so
			// an engagement event that carries no usable timestamp still leaves
			// through the empty array rather than 400-ing the batch it arrived in.
			return null;
	}
}

export const ${names.camel}Webhook: PluginSendTransportWebhookModule = {
	parseEvents(rawBody: string): readonly PluginWebhookFeedbackEvent[] {
		let parsed: unknown;
		try {
			parsed = JSON.parse(rawBody);
		} catch {
			throw new TypeError('${names.id}: body is not JSON');
		}
		if (typeof parsed !== 'object' || parsed === null) {
			throw new TypeError('${names.id}: body is not an object');
		}
		const events = (parsed as Record<string, unknown>)['events'];
		// The console's unsigned "is this endpoint alive?" ping carries no events.
		if (events === undefined) return [];
		if (!Array.isArray(events)) {
			throw new TypeError('${names.id}: events is not an array');
		}
		const out: PluginWebhookFeedbackEvent[] = [];
		for (const raw of events as readonly WireEvent[]) {
			if (typeof raw !== 'object' || raw === null) {
				throw new TypeError('${names.id}: event is not an object');
			}
			const event = toFeedbackEvent(raw);
			if (event) out.push(event);
		}
		return out;
	},
};
`;
}

export function domainIdentitySource(names: SendProviderNames): string {
	const c = SEND_PROVIDER_ENV_CONSTANTS;
	return `/**
 * ${names.id} — the SENDING-DOMAIN IDENTITY half of the bundle.
 *
 * OBSERVATIONS, NEVER A VERDICT. Report what the provider currently sees —
 * ownership, the two record verdicts, the DKIM selectors it signs under and the
 * SPF mechanisms it needs authorised — and the HOST derives \`verified\` from
 * those. There is no \`status\` field to return, which is what makes "verified"
 * mean the same thing at every relay tier.
 *
 * THE THREE OUTCOMES ARE NOT INTERCHANGEABLE, because the host's write rules
 * differ: only \`ok\` refreshes the proof's age, only \`auth_failed\` condemns a
 * credential, and \`unavailable\` (which a thrown error is also read as) changes
 * nothing but the retry. Returning \`ok\` for an outage would keep a stale proof
 * alive; returning \`auth_failed\` for one would condemn a working key.
 *
 * ISOLATE-SAFE, like the webhook half: \`domains/providers/\` imports the generated
 * registry on the enqueue path. \`fetch\` is available in both runtimes.
 */

import type {
	PluginDomainIdentityResult,
	PluginSendTransportConfig,
	PluginSendTransportDomainIdentityModule,
} from '@owlat/plugin-kit';
import { ${c.apiKey} } from '../envNames';

/** TODO: your provider's sending-domain endpoint. */
const IDENTITY_ENDPOINT = 'https://api.${names.id}.example/v1/domains';

/** TODO: the DKIM selector(s) your provider signs a registered domain under. */
const DKIM_SELECTORS = ['${names.id.replace(/-/g, '')}'] as const;

/** TODO: the SPF mechanism a customer's domain must authorise, if any. */
const SPF_MECHANISMS = ['include:spf.${names.id}.example'] as const;

/** TODO: your provider's domain response shape. */
interface DomainResponse {
	readonly verified?: unknown;
	readonly spf_valid?: unknown;
	readonly dkim_valid?: unknown;
}

/** One call, with the outcome split the host's write rules need. */
async function call(
	method: 'GET' | 'POST',
	domain: string,
	config: PluginSendTransportConfig
): Promise<PluginDomainIdentityResult> {
	const apiKey = config.env[${c.apiKey}];
	if (!apiKey) return { outcome: 'auth_failed', error: 'no API key for this instance' };

	let response: Response;
	try {
		response = await fetch(\`\${IDENTITY_ENDPOINT}/\${encodeURIComponent(domain)}\`, {
			method,
			headers: { authorization: \`Bearer \${apiKey}\` },
		});
	} catch (cause) {
		return { outcome: 'unavailable', error: \`request failed: \${String(cause)}\` };
	}
	if (response.status === 401 || response.status === 403) {
		return { outcome: 'auth_failed', error: 'the provider rejected this credential' };
	}
	if (!response.ok) {
		return { outcome: 'unavailable', error: \`provider answered \${response.status}\` };
	}

	const body = (await response.json()) as DomainResponse;
	return {
		outcome: 'ok',
		state: {
			isOwnershipVerified: body.verified === true,
			spf: { isValid: body.spf_valid === true },
			dkim: { isValid: body.dkim_valid === true },
			// An EMPTY selector list is read as "we cannot describe this domain's
			// signing identity", which HOLDS the dual-transport ramp at s=0. Return
			// the selectors whenever you know them.
			dkimSelectors: [...DKIM_SELECTORS],
			spfMechanisms: [...SPF_MECHANISMS],
		},
	};
}

export const ${names.camel}DomainIdentity: PluginSendTransportDomainIdentityModule = {
	/** The WRITE: create the identity at the provider, idempotently. */
	registerDomain(
		domain: string,
		config: PluginSendTransportConfig
	): Promise<PluginDomainIdentityResult> {
		return call('POST', domain, config);
	},

	/** The READ the host repeats on its own schedule to keep the proof fresh. */
	checkDomain(
		domain: string,
		config: PluginSendTransportConfig
	): Promise<PluginDomainIdentityResult> {
		return call('GET', domain, config);
	},
};
`;
}
