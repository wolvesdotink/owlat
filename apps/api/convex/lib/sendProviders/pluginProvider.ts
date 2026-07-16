'use node';

import {
	PLUGIN_SEND_FAILURE_CODES,
	type PluginSendTransportKind,
	type PluginSendTransportModule,
	type PluginSendTransportParams,
} from '@owlat/plugin-kit';
import type { EmailSendAttempt, EmailSendParams } from './types';
import { EmailErrorCode } from './types';

export interface HostedSendProviderModule {
	readonly kind: PluginSendTransportKind;
	readonly retryDelays: readonly number[];
	sendEmail(params: EmailSendParams, extras?: unknown): Promise<EmailSendAttempt>;
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
	moduleInput: unknown
): HostedSendProviderModule {
	const module = parseHostedSendTransportModule(moduleInput);
	return Object.freeze({
		kind,
		retryDelays: Object.freeze([...retryDelays]),
		async sendEmail(params: EmailSendParams, extras?: unknown): Promise<EmailSendAttempt> {
			try {
				const parsedExtras = module.parseExtras(extras);
				const result = await module.send(toPluginParams(params), parsedExtras);
				return parsePluginAttempt(result);
			} catch {
				return pluginFailure(EmailErrorCode.UNKNOWN);
			}
		},
	});
}

export function parseHostedSendTransportModule(input: unknown): PluginSendTransportModule<unknown> {
	const values = readExactDataObject(input, ['parseExtras', 'send']);
	if (typeof values['parseExtras'] !== 'function' || typeof values['send'] !== 'function') {
		throw new TypeError('Invalid bundled send transport module');
	}
	return Object.freeze({
		parseExtras: values['parseExtras'] as (input: unknown) => unknown,
		send: values['send'] as PluginSendTransportModule<unknown>['send'],
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

function readExactDataObject(
	input: unknown,
	expectedKeys: readonly string[]
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
		keys.length !== expectedKeys.length ||
		keys.some((key) => typeof key !== 'string' || !expectedKeys.includes(key))
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
	return values;
}
