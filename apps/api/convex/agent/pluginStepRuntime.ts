import type { PluginAgentStepInput } from '@owlat/plugin-kit';
import type { Doc } from '../_generated/dataModel';
import { encodePluginStorageValue } from '../plugins/storageJson';
import { openInboundMessageBody } from '../lib/messageBody';

export const PLUGIN_AGENT_STEP_INPUT_LIMITS = Object.freeze({
	fromCodePoints: 512,
	toCodePoints: 2_048,
	subjectCodePoints: 1_024,
	bodyCodePoints: 64 * 1_024,
});
const MAX_CAUTION_REASON_CODE_POINTS = 500;

export interface HostedPluginStepResult {
	readonly kind: 'continue' | 'caution';
	readonly to?: 'archived' | 'draft_ready' | 'failed';
	/** Fixed host-owned metadata. No plugin-authored text crosses this boundary. */
	readonly actionSummaryJson: string;
}

export async function buildPluginAgentStepInput(
	message: Doc<'inboundMessages'>
): Promise<PluginAgentStepInput> {
	const body = await openInboundMessageBody(message);
	return Object.freeze({
		inboundMessageId: message._id,
		from: truncateCodePoints(message.from, PLUGIN_AGENT_STEP_INPUT_LIMITS.fromCodePoints),
		to: truncateCodePoints(message.to, PLUGIN_AGENT_STEP_INPUT_LIMITS.toCodePoints),
		subject: truncateCodePoints(message.subject, PLUGIN_AGENT_STEP_INPUT_LIMITS.subjectCodePoints),
		textBody: boundedBody(body.text),
		htmlBody: boundedBody(body.html),
	});
}

/** Validate an untrusted result while retaining only a host-owned summary. */
export function parsePluginAgentStepResult(value: unknown): HostedPluginStepResult {
	if (!isPlainObject(value)) throw new TypeError('Invalid hosted agent step result');
	const kind = dataField(value, 'kind', true);
	const output = dataField(value, 'output', false);
	if (output !== undefined) encodePluginStorageValue(output);
	if (kind === 'continue') {
		assertExactFields(value, new Set(['kind', 'output']));
		return Object.freeze({ kind, actionSummaryJson: '{"result":"continue"}' });
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
		!hasAtMostCodePoints(reason, MAX_CAUTION_REASON_CODE_POINTS)
	) {
		throw new TypeError('Invalid hosted agent step caution reason');
	}
	return Object.freeze({
		kind,
		to,
		actionSummaryJson: `{"result":"caution","target":"${to}"}`,
	});
}

export function isDeclaredPluginCautionEdge(
	edges: readonly Readonly<{
		kind: 'caution' | 'draft_review';
		from: string;
		to: string;
	}>[],
	placement: 'classification' | 'before_draft' | 'after_draft',
	from: string,
	to: string
): boolean {
	const expectedKind = to === 'draft_ready' ? 'draft_review' : 'caution';
	const placementAllowsEdge =
		(placement === 'classification' && from === 'classifying' && to !== 'draft_ready') ||
		(placement === 'before_draft' && from === 'drafting' && to !== 'draft_ready') ||
		(placement === 'after_draft' && from === 'drafting');
	return (
		placementAllowsEdge &&
		edges.some((edge) => edge.kind === expectedKind && edge.from === from && edge.to === to)
	);
}

function boundedBody(value: string | undefined): string | undefined {
	return value === undefined
		? undefined
		: truncateCodePoints(value, PLUGIN_AGENT_STEP_INPUT_LIMITS.bodyCodePoints);
}

/** Truncate by Unicode code points, never splitting a surrogate pair. */
export function truncateCodePoints(value: string, limit: number): string {
	let count = 0;
	let codeUnitEnd = 0;
	for (const codePoint of value) {
		if (count === limit) return value.slice(0, codeUnitEnd);
		count += 1;
		codeUnitEnd += codePoint.length;
	}
	return value;
}

function hasAtMostCodePoints(value: string, limit: number): boolean {
	let count = 0;
	for (const _codePoint of value) {
		count += 1;
		if (count > limit) return false;
	}
	return true;
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
