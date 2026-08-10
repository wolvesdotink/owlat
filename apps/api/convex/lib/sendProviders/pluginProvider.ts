'use node';

import {
	PLUGIN_SEND_FAILURE_CODES,
	type PluginSendDispatchContext,
	type PluginSendSystemMailContext,
	type PluginSendTransportConfig,
	type PluginSendTransportKind,
	type PluginSendTransportModule,
	type PluginSendTransportParams,
} from '@owlat/plugin-kit';
import type {
	DispatchExtrasInput,
	EmailSendAttempt,
	EmailSendParams,
	ReturnPathProbeCapableModule,
	SystemMailExtrasInput,
} from './types';
import { EmailErrorCode } from './types';
import { readExactDataObject as readExactHostedDataObject } from '../../plugins/hostedModuleSnapshot';
import { resolvePluginTransportConfig } from './pluginTransportConfig';
import type { SendTransportRecord } from './transports';

/**
 * The hosted (plugin) send surface. It extends {@link ReturnPathProbeCapableModule}
 * only so callers can ask ONE question of any adapter; `createHostedSendProvider`
 * never populates `sendReturnPathProbe`, because the plugin transport contract
 * has no envelope-sender knob it could carry a SIGNED VERP local part on. A
 * plugin kind is therefore settled without a send rather than probed on somebody
 * else's wire — which is why the kit's `supportsCustomReturnPath` union has only
 * `no` in it, and why `catalog.ts` re-asserts that on the generated artifact.
 *
 * The two extras builders mirror the core adapter interface exactly (the seams
 * plan's P3.1): the governed boundary and the system-mail path ask every module
 * the same question and neither knows which tier answered.
 */
export interface HostedSendProviderModule extends ReturnPathProbeCapableModule {
	readonly kind: PluginSendTransportKind;
	readonly retryDelays: readonly number[];
	sendEmail(
		transport: SendTransportRecord,
		params: EmailSendParams,
		extras?: unknown
	): Promise<EmailSendAttempt>;
	buildDispatchExtras?(input: DispatchExtrasInput): unknown;
	buildSystemMailExtras?(input: SystemMailExtrasInput): unknown;
}

/**
 * The configuration surface a hosted transport was composed with — the variables
 * the host resolves per instance and hands to the module.
 *
 * `required` is a SUBSET of `instance`, computed by the composer as the
 * intersection of the entry's presence gate with its instance-scoped variables.
 * Stating it that way rather than reading the gate directly is deliberate: a
 * plugin entry's gate is a UNION that also carries the contributing PLUGIN's
 * deployment-wide flag variables, and those are the plugin's, not this
 * transport's to be handed.
 */
export interface HostedSendTransportConfigSpec {
	readonly instanceEnvVars: readonly string[];
	readonly requiredEnvVars: readonly string[];
}

const failureCodeMap = {
	rate_limited: EmailErrorCode.RATE_LIMIT,
	temporary_failure: EmailErrorCode.SERVER_ERROR,
	ambiguous_timeout: EmailErrorCode.AMBIGUOUS_TIMEOUT,
	invalid_recipient: EmailErrorCode.INVALID_RECIPIENT,
	invalid_sender: EmailErrorCode.INVALID_SENDER,
	authentication_failed: EmailErrorCode.AUTH_FAILED,
	content_rejected: EmailErrorCode.CONTENT_REJECTED,
	unknown: EmailErrorCode.UNKNOWN,
} as const satisfies Record<(typeof PLUGIN_SEND_FAILURE_CODES)[number], EmailErrorCode>;

const failureCodes = new Set<string>(PLUGIN_SEND_FAILURE_CODES);

export function createHostedSendProvider(
	kind: PluginSendTransportKind,
	retryDelays: readonly number[],
	moduleInput: unknown,
	configSpec: HostedSendTransportConfigSpec = { instanceEnvVars: [], requiredEnvVars: [] }
): HostedSendProviderModule {
	const module = parseHostedSendTransportModule(moduleInput);
	const instanceEnvVars = Object.freeze([...configSpec.instanceEnvVars]);
	const requiredEnvVars = Object.freeze([...configSpec.requiredEnvVars]);
	return Object.freeze({
		kind,
		retryDelays: Object.freeze([...retryDelays]),
		/**
		 * THE RECORD IS READ NOW (the seams plan's P3.1). A hosted transport that
		 * declared configuration of its own is sent through the instance the id
		 * named: the host resolves that instance's variables — the base names for
		 * the default instance, the `__<INSTANCEKEY>`-suffixed ones for a named one
		 * — and hands the module exactly those. A transport that declared none gets
		 * the empty record and cannot have named instances at all, so `transport` is
		 * always its default and there is nothing to resolve.
		 *
		 * A MISSING REQUIRED VARIABLE FAILS THE ATTEMPT BEFORE THE MODULE RUNS,
		 * as `AUTH_FAILED` — terminal, not retried — which is what the core adapters'
		 * `transportEnvRequired` throw produces. Letting the module decide would put
		 * the fail-closed reading of a revoked credential in third-party hands.
		 */
		async sendEmail(
			transport: SendTransportRecord,
			params: EmailSendParams,
			extras?: unknown
		): Promise<EmailSendAttempt> {
			const config = resolveHostedConfig(transport, instanceEnvVars, requiredEnvVars);
			if (!config) return pluginFailure(EmailErrorCode.AUTH_FAILED);
			try {
				const parsedExtras = module.parseExtras(extras);
				const result = await module.send(toPluginParams(params), parsedExtras, config);
				return parsePluginAttempt(result);
			} catch {
				return pluginFailure(EmailErrorCode.UNKNOWN);
			}
		},
		/**
		 * The governed boundary's facts, narrowed to what a relay could act on.
		 *
		 * The governance identities on `DispatchExtrasInput` — the work-attempt id,
		 * the re-entry snapshot handle and the routing lease — are capability
		 * handles the backend authenticates itself with, and no transport has a send
		 * to make with them. They stop here.
		 *
		 * A THROWN BUILDER YIELDS NO EXTRAS rather than failing the send: this runs
		 * inside the governed boundary, before any dispatch bookkeeping, and a
		 * third-party builder that throws must not be able to take down the send path
		 * for a knob that is optional by construction. It is not SILENT, though — a
		 * builder that always throws would otherwise be indistinguishable from one
		 * that works, so the failure is logged against the kind (outcome only; the
		 * thrown text is untrusted and may quote configuration).
		 */
		...(module.buildDispatchExtras === undefined
			? {}
			: {
					buildDispatchExtras(input: DispatchExtrasInput): unknown {
						try {
							return module.buildDispatchExtras?.(toPluginDispatchContext(input));
						} catch {
							console.warn(
								`[pluginSendTransport] ${kind} buildDispatchExtras threw; sending without extras`
							);
							return undefined;
						}
					},
				}),
		/**
		 * THE SYSTEM-MAIL BUILDER'S THROW PROPAGATES, and the asymmetry with the
		 * builder above is the whole point of the dedup pair.
		 *
		 * Empty extras here are indistinguishable from extras that carried the
		 * idempotency key, while `systemMailRetryDisposition` keeps reading the
		 * catalog's `deduplicatesOnIdempotencyKey` — so a swallowed throw would have
		 * an ambiguous password reset reported `safe_to_retry` with no key ever sent,
		 * and the "retry" is a second mail to a real person. `systemMail.ts` builds
		 * its extras inside the try that wraps the attempt, so a throw becomes a
		 * failed attempt BEFORE any mail goes out. That is the fail-closed answer,
		 * and it is the one the registry's pair guard promises.
		 */
		...(module.buildSystemMailExtras === undefined
			? {}
			: {
					buildSystemMailExtras(input: SystemMailExtrasInput): unknown {
						return module.buildSystemMailExtras?.({
							...(input.idempotencyKey === undefined
								? {}
								: { idempotencyKey: input.idempotencyKey }),
						} satisfies PluginSendSystemMailContext);
					},
				}),
	});
}

/**
 * Resolve this instance's configuration, or `null` when a required variable is
 * absent.
 *
 * The resolution itself is `pluginTransportConfig.resolvePluginTransportConfig`,
 * shared with the sending-domain identity half — the two tiers hand the SAME
 * `PluginSendTransportConfig` shape to the same third-party module, so a
 * refinement to how it is built has to reach both. All this adds is the
 * transport's instance.
 */
function resolveHostedConfig(
	transport: SendTransportRecord,
	instanceEnvVars: readonly string[],
	requiredEnvVars: readonly string[]
): PluginSendTransportConfig | null {
	return resolvePluginTransportConfig(transport.instanceKey, instanceEnvVars, requiredEnvVars);
}

/**
 * The governed dispatch input, narrowed to what a bundled transport may act on.
 *
 * `relayReturnPathHost` IS DELIBERATELY NOT CARRIED ACROSS, and it is the one
 * omission a reader will trip over, because the field is right there on the
 * input. It is resolved for ONE transport kind — the probe-decided relay the
 * route selected — and only after `relayReturnPathHostFor` has checked that
 * host's published SPF authorises THAT relay's sending IPs. Handing the same
 * string to a plugin kind that happened to win the same route would invite it to
 * stamp an envelope-sender domain whose SPF does not list its outbound IPs,
 * failing SPF on the bounce domain of every send it stamped. And it would not buy
 * anything even then: the VERP local part that makes a bounce attributable is
 * signed with a deployment secret inside the host's own relay adapter, so a bare
 * host is not a return path a module could use. Which is why the kit's
 * `supportsCustomReturnPath` has only `no` at this tier.
 */
function toPluginDispatchContext(input: DispatchExtrasInput): PluginSendDispatchContext {
	return Object.freeze({
		idempotencyKey: input.idempotencyKey,
		messageType: input.messageType,
		deliveryDomain: input.deliveryDomain,
		...(input.ipPool === undefined ? {} : { ipPool: input.ipPool }),
		...(input.warmupOverflowEnabled === undefined
			? {}
			: { warmupOverflowEnabled: input.warmupOverflowEnabled }),
		...(input.engagementScore === undefined ? {} : { engagementScore: input.engagementScore }),
	});
}

/**
 * Accept a plain object exposing `parseExtras` and `send` as data properties,
 * plus either extras builder.
 *
 * The two builders are OPTIONAL and the rest of the key set is still exact: a
 * generated import carrying a getter, a prototype, or a key this contract does
 * not have is a failure that must happen at module load, not one frame inside a
 * live send.
 */
export function parseHostedSendTransportModule(input: unknown): PluginSendTransportModule<unknown> {
	const values = readExactDataObject(
		input,
		['parseExtras', 'send'],
		['buildDispatchExtras', 'buildSystemMailExtras']
	);
	if (typeof values['parseExtras'] !== 'function' || typeof values['send'] !== 'function') {
		throw new TypeError('Invalid bundled send transport module');
	}
	for (const builder of ['buildDispatchExtras', 'buildSystemMailExtras'] as const) {
		if (values[builder] !== undefined && typeof values[builder] !== 'function') {
			throw new TypeError('Invalid bundled send transport module');
		}
	}
	return Object.freeze({
		parseExtras: values['parseExtras'] as (input: unknown) => unknown,
		send: values['send'] as PluginSendTransportModule<unknown>['send'],
		...(values['buildDispatchExtras'] === undefined
			? {}
			: {
					buildDispatchExtras: values['buildDispatchExtras'] as (context: unknown) => unknown,
				}),
		...(values['buildSystemMailExtras'] === undefined
			? {}
			: {
					buildSystemMailExtras: values['buildSystemMailExtras'] as (context: unknown) => unknown,
				}),
	});
}

function toPluginParams(params: EmailSendParams): PluginSendTransportParams {
	return Object.freeze({
		to: params.to,
		from: params.from,
		subject: params.subject,
		html: params.html,
		...(params.text === undefined ? {} : { text: params.text }),
		...(params.replyTo === undefined ? {} : { replyTo: params.replyTo }),
		...(params.headers === undefined ? {} : { headers: Object.freeze({ ...params.headers }) }),
		...(params.attachments === undefined
			? {}
			: {
					attachments: Object.freeze(
						params.attachments.map((attachment) =>
							Object.freeze({
								filename: attachment.filename,
								content: new Uint8Array(attachment.content),
								...(attachment.contentType === undefined
									? {}
									: { contentType: attachment.contentType }),
							})
						)
					),
				}),
	});
}

function parsePluginAttempt(input: unknown): EmailSendAttempt {
	if (input === null || typeof input !== 'object') return pluginFailure(EmailErrorCode.UNKNOWN);
	let success: unknown;
	try {
		success = Object.getOwnPropertyDescriptor(input, 'success')?.value;
	} catch {
		return pluginFailure(EmailErrorCode.UNKNOWN);
	}
	if (success === true) {
		const values = readExactDataObject(input, ['success', 'id']);
		if (
			typeof values['id'] !== 'string' ||
			values['id'].length === 0 ||
			values['id'].length > 512
		) {
			return pluginFailure(EmailErrorCode.UNKNOWN);
		}
		return { success: true, id: values['id'] };
	}
	if (success === false) {
		const values = readExactDataObject(input, ['success', 'code']);
		if (typeof values['code'] !== 'string' || !failureCodes.has(values['code'])) {
			return pluginFailure(EmailErrorCode.UNKNOWN);
		}
		return pluginFailure(failureCodeMap[values['code'] as keyof typeof failureCodeMap]);
	}
	return pluginFailure(EmailErrorCode.UNKNOWN);
}

function pluginFailure(errorCode: EmailErrorCode): EmailSendAttempt {
	return { success: false, errorCode, errorMessage: 'Bundled send transport failed' };
}

/**
 * The exact-shape reader, with this tier's message bound in.
 *
 * The RULE lives in `plugins/hostedModuleSnapshot.ts` — every own key must be one
 * this contract knows, every required key must be present, and every value must
 * be a plain data property on a plain object with a plain prototype — because the
 * feedback half and the sending-domain identity half read their generated modules
 * against the same bar, and three copies of it meant the next hardening would
 * land in one of them.
 */
function readExactDataObject(
	input: unknown,
	expectedKeys: readonly string[],
	optionalKeys: readonly string[] = []
): Record<string, unknown> {
	return readExactHostedDataObject(
		input,
		expectedKeys,
		optionalKeys,
		'Invalid bundled send transport value'
	);
}
