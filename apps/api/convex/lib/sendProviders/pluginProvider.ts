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
import { getPluginTransportEnv } from '../env';
import type {
	DispatchExtrasInput,
	EmailSendAttempt,
	EmailSendParams,
	ReturnPathProbeCapableModule,
	SystemMailExtrasInput,
} from './types';
import { EmailErrorCode } from './types';
import { sendTransportEnvName, type SendTransportRecord } from './transports';

/**
 * The hosted (plugin) send surface. It extends {@link ReturnPathProbeCapableModule}
 * only so callers can ask ONE question of any adapter; `createHostedSendProvider`
 * never populates `sendReturnPathProbe`, because the plugin transport contract
 * has no envelope-sender knob it could carry a SIGNED VERP local part on. A
 * plugin kind is therefore settled without a send rather than probed on somebody
 * else's wire — which is also why the kit's `supportsCustomReturnPath` union has
 * no `probe` member to declare.
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
 * plugin entry that declares no configuration of its own carries the PLUGIN's
 * flag variables as its gate, and those are not this transport's to be handed.
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
 * Keyed by the BASE name whatever the instance, so a module reads
 * `env['PLUGIN_ACME_TOKEN']` for every transport id it is sent through — the same
 * property `transportEnv.ts` gives a core adapter, which reads its typed `EnvKey`
 * and never spells the suffix either.
 */
function resolveHostedConfig(
	transport: SendTransportRecord,
	instanceEnvVars: readonly string[],
	requiredEnvVars: readonly string[]
): PluginSendTransportConfig | null {
	const env: Record<string, string> = {};
	for (const name of instanceEnvVars) {
		const value = getPluginTransportEnv(sendTransportEnvName(name, transport.instanceKey));
		if (value !== undefined) env[name] = value;
	}
	for (const name of requiredEnvVars) {
		if (env[name] === undefined) return null;
	}
	return Object.freeze({ instanceKey: transport.instanceKey, env: Object.freeze(env) });
}

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
		...(input.relayReturnPathHost === undefined
			? {}
			: { returnPathHost: input.relayReturnPathHost }),
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
 * Every own key must be one this contract knows, every REQUIRED key must be
 * present, and every value must be a plain data property on a plain object.
 *
 * `optionalKeys` is what lets a module ship an extras builder without loosening
 * anything else: an unknown key is still refused, so a bundled module cannot
 * smuggle in a surface the host never agreed to call.
 */
function readExactDataObject(
	input: unknown,
	expectedKeys: readonly string[],
	optionalKeys: readonly string[] = []
): Record<string, unknown> {
	if (input === null || typeof input !== 'object' || Array.isArray(input)) {
		throw new TypeError('Invalid bundled send transport value');
	}
	let prototype: object | null;
	let descriptors: Record<PropertyKey, PropertyDescriptor>;
	try {
		prototype = Object.getPrototypeOf(input);
		descriptors = Object.getOwnPropertyDescriptors(input);
	} catch {
		throw new TypeError('Invalid bundled send transport value');
	}
	if (prototype !== Object.prototype && prototype !== null) {
		throw new TypeError('Invalid bundled send transport value');
	}
	const keys = Reflect.ownKeys(descriptors);
	if (
		keys.length < expectedKeys.length ||
		keys.some(
			(key) =>
				typeof key !== 'string' || !(expectedKeys.includes(key) || optionalKeys.includes(key))
		)
	) {
		throw new TypeError('Invalid bundled send transport value');
	}
	const values: Record<string, unknown> = {};
	for (const key of expectedKeys) {
		const descriptor = descriptors[key];
		if (!descriptor?.enumerable || !('value' in descriptor)) {
			throw new TypeError('Invalid bundled send transport value');
		}
		values[key] = descriptor.value;
	}
	for (const key of optionalKeys) {
		const descriptor = descriptors[key];
		if (descriptor === undefined) continue;
		if (!descriptor.enumerable || !('value' in descriptor)) {
			throw new TypeError('Invalid bundled send transport value');
		}
		values[key] = descriptor.value;
	}
	return values;
}
