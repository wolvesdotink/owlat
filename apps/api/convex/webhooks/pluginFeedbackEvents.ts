/**
 * Host-side revalidation of the events a bundled plugin's webhook module parsed
 * (the seams plan's D6/P2.2).
 *
 * A plugin's parse output is UNTRUSTED INPUT — the same stance
 * `pluginProvider.parsePluginAttempt` takes toward a send result. Authenticity
 * of the bytes was proved before the module ran, but nothing about the module's
 * output is proved by that: it is code that read a third party's payload, and
 * the values it returns become state in the delivery record and counters in the
 * measurement plane. So every value is re-checked here, against a vocabulary
 * narrower than the host's own inbound union, and anything outside it fails the
 * whole batch rather than being dropped silently (a batch that half-applies is
 * worse than one the provider redelivers).
 *
 * `providerType` is stamped by the HOST from the registry's own kind, never read
 * from the plugin's output: it is what the measurement plane attributes the
 * outcome to, and letting a plugin name it would let one transport's feedback be
 * graded against another's arm.
 */

import {
	PLUGIN_WEBHOOK_FEEDBACK_KINDS,
	PLUGIN_WEBHOOK_MAX_BATCH_EVENTS,
	type PluginWebhookFeedbackKind,
} from '@owlat/plugin-kit';
import type { InboundEvent } from './types';

/**
 * Largest batch one delivery may carry.
 *
 * DECLARED IN THE KIT, not here: it is a term of the contract a plugin author
 * writes against, and one an author cannot honour without knowing the number —
 * an over-limit batch is feedback that never arrives (the provider redelivers
 * the same oversized body), not backpressure. The host re-states nothing; it
 * enforces what the contract published.
 */
export const MAX_PLUGIN_FEEDBACK_EVENTS = PLUGIN_WEBHOOK_MAX_BATCH_EVENTS;
/** Longest accepted provider-supplied string (ids, addresses, free text). */
const MAX_TEXT_LENGTH = 998;

const FEEDBACK_KINDS = new Set<string>(PLUGIN_WEBHOOK_FEEDBACK_KINDS);

export class PluginFeedbackEventError extends TypeError {}

/**
 * A well-formed batch that is simply too big.
 *
 * Split from its parent so the route can answer it 413 with the limit in the
 * message instead of the generic 400 "Invalid event payload": from the
 * provider's own delivery log, an over-limit batch and a malformed body are
 * otherwise the same event, and the operator's fix (chunk the batch) is
 * undiscoverable.
 */
export class PluginFeedbackBatchTooLargeError extends PluginFeedbackEventError {}

/**
 * Convert a plugin module's return value into inbound events, or throw.
 *
 * The caller answers a throw with 400 (413 for {@link
 * PluginFeedbackBatchTooLargeError}) and releases its replay claim, so a
 * rejected batch is a delivery the provider may retry — never one silently
 * accepted with fewer events than it carried.
 */
export function parsePluginFeedbackEvents(
	parsed: unknown,
	transportKind: string
): readonly InboundEvent[] {
	if (!Array.isArray(parsed)) {
		throw new PluginFeedbackEventError('Plugin webhook module did not return an event array');
	}
	if (parsed.length > MAX_PLUGIN_FEEDBACK_EVENTS) {
		throw new PluginFeedbackBatchTooLargeError(
			`Batch too large: at most ${MAX_PLUGIN_FEEDBACK_EVENTS} events`
		);
	}
	return Object.freeze(parsed.map((event) => parseEvent(event, transportKind)));
}

function parseEvent(input: unknown, providerType: string): InboundEvent {
	const event = readObject(input);
	const kind = readKind(event['kind']);
	const at = readTimestamp(event['at']);
	switch (kind) {
		case 'delivered':
			return {
				kind: 'email.delivered',
				providerMessageId: readRequiredText(event['providerMessageId'], 'providerMessageId'),
				at,
				providerType,
				...optionalText('recipient', event['recipient']),
			};
		case 'bounced':
			return {
				kind: 'email.bounced',
				providerMessageId: readRequiredText(event['providerMessageId'], 'providerMessageId'),
				at,
				bounceType: readBounceType(event['bounceType']),
				providerType,
				...optionalText('bounceMessage', event['bounceMessage']),
			};
		case 'complained': {
			// The one event that may arrive with an address and no message id:
			// RFC 5965 §3.2 redaction is routine, and the dispatcher suppresses by
			// address in that case. It must still carry ONE of the two, or it names
			// nothing and could only be recorded against a guess.
			const providerMessageId = optionalText('providerMessageId', event['providerMessageId']);
			const recipient = optionalText('recipient', event['recipient']);
			if (!('providerMessageId' in providerMessageId) && !('recipient' in recipient)) {
				throw new PluginFeedbackEventError(
					'Plugin complaint carries neither providerMessageId nor recipient'
				);
			}
			return { kind: 'email.complained', at, providerType, ...providerMessageId, ...recipient };
		}
		case 'deferred':
			return {
				kind: 'email.deferred',
				providerMessageId: readRequiredText(event['providerMessageId'], 'providerMessageId'),
				at,
				providerType,
				...optionalText('reason', event['reason']),
			};
	}
}

/**
 * Read own data properties only, off a plain object.
 *
 * A getter would be code running during validation, and a prototype could make
 * an absent field resolve to an inherited one — so both are refused rather than
 * read, exactly as the manifest validators do at the other untrusted boundary.
 */
function readObject(input: unknown): Record<string, unknown> {
	if (input === null || typeof input !== 'object' || Array.isArray(input)) {
		throw new PluginFeedbackEventError('Plugin webhook event must be a plain object');
	}
	const prototype = Object.getPrototypeOf(input);
	if (prototype !== Object.prototype && prototype !== null) {
		throw new PluginFeedbackEventError('Plugin webhook event must be a plain object');
	}
	const values: Record<string, unknown> = {};
	for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(input))) {
		if (!('value' in descriptor)) {
			throw new PluginFeedbackEventError('Plugin webhook event field must be a data property');
		}
		values[key] = descriptor.value;
	}
	return values;
}

function readKind(value: unknown): PluginWebhookFeedbackKind {
	if (typeof value !== 'string' || !FEEDBACK_KINDS.has(value)) {
		throw new PluginFeedbackEventError('Plugin webhook event kind is not supported');
	}
	return value as PluginWebhookFeedbackKind;
}

/**
 * Epoch milliseconds, and a plausible one. A provider clock far outside the
 * window this deployment can have observed would land a row that reads as
 * ancient or future to every consumer that orders by it.
 */
function readTimestamp(value: unknown): number {
	if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) {
		throw new PluginFeedbackEventError('Plugin webhook event timestamp must be epoch milliseconds');
	}
	const now = Date.now();
	if (value > now + 86_400_000 || value < now - 31_536_000_000) {
		throw new PluginFeedbackEventError('Plugin webhook event timestamp is out of range');
	}
	return value;
}

function readBounceType(value: unknown): 'hard' | 'soft' {
	if (value !== 'hard' && value !== 'soft') {
		throw new PluginFeedbackEventError('Plugin bounce type must be hard or soft');
	}
	return value;
}

function readRequiredText(value: unknown, field: string): string {
	if (typeof value !== 'string' || value.length === 0 || value.length > MAX_TEXT_LENGTH) {
		throw new PluginFeedbackEventError(`Plugin webhook event ${field} is missing or oversized`);
	}
	return value;
}

/**
 * An optional string as a spreadable fragment: absent when the field is absent,
 * a rejection when it is present but not a bounded string. Present-but-empty is
 * absent — a provider sending `""` means "no value", not a value of nothing.
 */
function optionalText(field: string, value: unknown): Record<string, string> {
	if (value === undefined || value === null || value === '') return {};
	return { [field]: readRequiredText(value, field) };
}
