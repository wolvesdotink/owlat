import type { ModelMessage } from 'ai';
import type { PluginLlmTier } from '@owlat/plugin-kit';

export const PLUGIN_LLM_MAX_INPUT_BYTES = 64 * 1024;
export const PLUGIN_LLM_MAX_MESSAGE_BYTES = 32 * 1024;
export const PLUGIN_LLM_MAX_MESSAGES = 32;
export const PLUGIN_LLM_MAX_OUTPUT_TOKENS = 2048;
export const PLUGIN_LLM_PROTOCOL_TOKEN_RESERVE = 1024;

export interface ValidatedPluginLlmRequest {
	readonly tier: PluginLlmTier;
	readonly inputTokensUpperBound: number;
	readonly dispatchInput: { readonly prompt: string; readonly system?: string } | {
		readonly messages: ModelMessage[];
	};
}

export function validatePluginLlmRequest(input: unknown): ValidatedPluginLlmRequest {
	const request = readRecord(input, new Set(['tier', 'prompt', 'system', 'messages']));
	const tier = dataField(request, 'tier');
	if (tier !== 'fast' && tier !== 'capable') throw new TypeError('Invalid plugin LLM request');
	const prompt = optionalStringField(request, 'prompt');
	const system = optionalStringField(request, 'system');
	const messagesValue = dataField(request, 'messages');
	const hasMessages = messagesValue !== undefined;
	if (hasMessages === (prompt !== undefined)) throw new TypeError('Invalid plugin LLM request');

	if (!hasMessages) {
		const inputBytes = utf8Bytes(prompt!) + (system === undefined ? 0 : utf8Bytes(system));
		assertInputBytes(inputBytes);
		return Object.freeze({
			tier,
			inputTokensUpperBound: inputBytes + PLUGIN_LLM_PROTOCOL_TOKEN_RESERVE,
			dispatchInput: Object.freeze({ prompt: prompt!, ...(system === undefined ? {} : { system }) }),
		});
	}
	if (system !== undefined) throw new TypeError('Invalid plugin LLM request');

	const values = readDenseArray(messagesValue);
	if (values.length < 1 || values.length > PLUGIN_LLM_MAX_MESSAGES) {
		throw new TypeError('Invalid plugin LLM request');
	}
	let inputBytes = 0;
	const messages: ModelMessage[] = values.map((value) => {
		const message = readRecord(value, new Set(['role', 'content']));
		const role = dataField(message, 'role');
		const content = dataField(message, 'content');
		if (
			(role !== 'assistant' && role !== 'system' && role !== 'user') ||
			typeof content !== 'string'
		) {
			throw new TypeError('Invalid plugin LLM request');
		}
		const contentBytes = utf8Bytes(content);
		if (contentBytes > PLUGIN_LLM_MAX_MESSAGE_BYTES) throw new TypeError('Invalid plugin LLM request');
		inputBytes += contentBytes;
		return Object.freeze({ role, content });
	});
	assertInputBytes(inputBytes);
	return Object.freeze({
		tier,
		inputTokensUpperBound: inputBytes + PLUGIN_LLM_PROTOCOL_TOKEN_RESERVE,
		dispatchInput: Object.freeze({ messages: Object.freeze(messages) as unknown as ModelMessage[] }),
	});
}

function readRecord(value: unknown, allowed: ReadonlySet<string>): Record<string, PropertyDescriptor> {
	if (value === null || typeof value !== 'object' || Array.isArray(value)) {
		throw new TypeError('Invalid plugin LLM request');
	}
	let prototype: object | null;
	let descriptors: Record<PropertyKey, PropertyDescriptor>;
	try {
		prototype = Object.getPrototypeOf(value);
		descriptors = Object.getOwnPropertyDescriptors(value) as unknown as Record<
			PropertyKey,
			PropertyDescriptor
		>;
	} catch {
		throw new TypeError('Invalid plugin LLM request');
	}
	if (prototype !== Object.prototype && prototype !== null) throw new TypeError('Invalid plugin LLM request');
	for (const key of Reflect.ownKeys(descriptors)) {
		if (typeof key !== 'string' || !allowed.has(key)) throw new TypeError('Invalid plugin LLM request');
		const descriptor = descriptors[key]!;
		if (!descriptor.enumerable || !('value' in descriptor)) throw new TypeError('Invalid plugin LLM request');
	}
	return descriptors as Record<string, PropertyDescriptor>;
}

function dataField(record: Record<string, PropertyDescriptor>, key: string): unknown {
	return record[key]?.value;
}

function optionalStringField(record: Record<string, PropertyDescriptor>, key: string): string | undefined {
	const value = dataField(record, key);
	if (value !== undefined && typeof value !== 'string') throw new TypeError('Invalid plugin LLM request');
	return value;
}

function readDenseArray(value: unknown): unknown[] {
	if (!Array.isArray(value)) throw new TypeError('Invalid plugin LLM request');
	let descriptors: Record<PropertyKey, PropertyDescriptor>;
	try {
		descriptors = Object.getOwnPropertyDescriptors(value) as unknown as Record<
			PropertyKey,
			PropertyDescriptor
		>;
	} catch {
		throw new TypeError('Invalid plugin LLM request');
	}
	const length = descriptors['length']?.value;
	if (!Number.isSafeInteger(length) || length < 0 || length > PLUGIN_LLM_MAX_MESSAGES) {
		throw new TypeError('Invalid plugin LLM request');
	}
	const result: unknown[] = [];
	const ownKeys = Reflect.ownKeys(descriptors);
	if (ownKeys.length !== length + 1 || !ownKeys.includes('length')) {
		throw new TypeError('Invalid plugin LLM request');
	}
	for (let index = 0; index < length; index++) {
		const descriptor = descriptors[String(index)];
		if (!descriptor?.enumerable || !('value' in descriptor)) throw new TypeError('Invalid plugin LLM request');
		result.push(descriptor.value);
	}
	return result;
}

function utf8Bytes(value: string): number {
	return new TextEncoder().encode(value).byteLength;
}

function assertInputBytes(bytes: number): void {
	if (bytes < 1 || bytes > PLUGIN_LLM_MAX_INPUT_BYTES) throw new TypeError('Invalid plugin LLM request');
}
