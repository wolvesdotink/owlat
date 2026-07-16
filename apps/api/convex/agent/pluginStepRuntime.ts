import type { PluginAgentStepInput } from '@owlat/plugin-kit';
import type { Doc } from '../_generated/dataModel';
import { encodePluginStorageValue } from '../plugins/storageJson';
import { openInboundMessageBody } from '../lib/messageBody';

const MAX_BODY_CHARS = 64 * 1024;
const MAX_CAUTION_REASON_CHARS = 500;

export interface HostedPluginStepResult {
	readonly kind: 'continue' | 'caution';
	readonly to?: 'archived' | 'draft_ready' | 'failed';
	readonly outputJson?: string;
}

export async function buildPluginAgentStepInput(
	message: Doc<'inboundMessages'>
): Promise<PluginAgentStepInput> {
	const body = await openInboundMessageBody(message);
	return Object.freeze({
		inboundMessageId: message._id,
		from: message.from,
		to: message.to,
		subject: message.subject,
		textBody: boundedBody(body.text),
		htmlBody: boundedBody(body.html),
	});
}

/** Snapshot an untrusted module result and bound its optional JSON output. */
export function parsePluginAgentStepResult(value: unknown): HostedPluginStepResult {
	if (!isPlainObject(value)) throw new TypeError('Invalid hosted agent step result');
	const kind = dataField(value, 'kind', true);
	const output = dataField(value, 'output', false);
	const outputJson = output === undefined ? undefined : encodePluginStorageValue(output).json;
	if (kind === 'continue') {
		assertExactFields(value, new Set(['kind', 'output']));
		return Object.freeze({ kind, outputJson });
	}
	if (kind !== 'caution') throw new TypeError('Invalid hosted agent step result');
	assertExactFields(value, new Set(['kind', 'to', 'reason', 'output']));
	const to = dataField(value, 'to', true);
	if (to !== 'archived' && to !== 'draft_ready' && to !== 'failed') {
		throw new TypeError('Invalid hosted agent step caution target');
	}
	const reason = dataField(value, 'reason', true);
	if (
		typeof reason !== 'string' ||
		reason.trim() !== reason ||
		reason.length === 0 ||
		reason.length > MAX_CAUTION_REASON_CHARS
	) {
		throw new TypeError('Invalid hosted agent step caution reason');
	}
	const cautionOutputJson = encodePluginStorageValue(
		output === undefined ? { reason } : { output, reason }
	).json;
	return Object.freeze({ kind, to, outputJson: cautionOutputJson });
}

export function isDeclaredPluginCautionEdge(
	edges: readonly Readonly<{ from: string; to: string }>[],
	from: string,
	to: string
): boolean {
	return edges.some((edge) => edge.from === from && edge.to === to);
}

function boundedBody(value: string | undefined): string | undefined {
	return value === undefined ? undefined : value.slice(0, MAX_BODY_CHARS);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
	const prototype = Object.getPrototypeOf(value);
	return prototype === Object.prototype || prototype === null;
}

function dataField(value: Record<string, unknown>, field: string, required: boolean): unknown {
	const descriptor = Object.getOwnPropertyDescriptor(value, field);
	if (!descriptor) {
		if (required) throw new TypeError('Invalid hosted agent step result');
		return undefined;
	}
	if (!('value' in descriptor) || !descriptor.enumerable) {
		throw new TypeError('Invalid hosted agent step result');
	}
	return descriptor.value;
}

function assertExactFields(value: Record<string, unknown>, allowed: ReadonlySet<string>): void {
	for (const key of Reflect.ownKeys(value)) {
		if (typeof key !== 'string' || !allowed.has(key)) {
			throw new TypeError('Invalid hosted agent step result');
		}
	}
}
