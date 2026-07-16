import type { MutationCtx } from '../_generated/server';
import {
	HOSTED_PLUGIN_OPERATION_LITERALS,
	type HostedPluginOperationLiteral,
} from '../auditActions/catalog';
import { recordAuditLog } from '../lib/auditLog';
import type { HostedPluginActorScope } from './authorization';

export type HostedPluginAuditOutcome = 'completed' | 'denied' | 'failed';
export type HostedPluginOperation = HostedPluginOperationLiteral;
export const HOSTED_PLUGIN_AUDIT_REASON_CODES = Object.freeze([
	'access_denied',
	'access_or_budget_denied',
	'agent_step_failed',
	'automation_step_failed',
	'autonomy_gate_failed',
	'autonomy_gate_invalid',
	'autonomy_gate_timeout',
	'draft_strategy_failed',
	'draft_strategy_invalid',
	'draft_strategy_timeout',
	'provider_dispatch_failed',
] as const);
export type HostedPluginAuditReasonCode = (typeof HOSTED_PLUGIN_AUDIT_REASON_CODES)[number];
const HOSTED_PLUGIN_OPERATION_SET: ReadonlySet<HostedPluginOperation> = new Set(
	HOSTED_PLUGIN_OPERATION_LITERALS
);
const HOSTED_PLUGIN_AUDIT_REASON_CODE_SET: ReadonlySet<HostedPluginAuditReasonCode> = new Set(
	HOSTED_PLUGIN_AUDIT_REASON_CODES
);

export interface HostedPluginAuditMetadata {
	readonly attempts?: number;
	readonly usageAvailable?: boolean;
	readonly chargedMicrousd?: number;
	readonly actualMicrousd?: number;
	readonly reasonCode?: HostedPluginAuditReasonCode;
}

const AUDIT_METADATA_FIELDS = new Set([
	'attempts',
	'usageAvailable',
	'chargedMicrousd',
	'actualMicrousd',
	'reasonCode',
]);

/**
 * Mutation-local audit primitive for PP-07+ host wrappers. Call it in the same
 * transaction as the hosted state change; never pass prompts, results, secrets,
 * or raw provider errors in details.
 */
export async function recordHostedPluginAudit(
	ctx: MutationCtx,
	scope: HostedPluginActorScope,
	operation: HostedPluginOperation,
	outcome: HostedPluginAuditOutcome,
	metadata: HostedPluginAuditMetadata = {}
): Promise<void> {
	if (!HOSTED_PLUGIN_OPERATION_SET.has(operation)) {
		throw new TypeError('Invalid hosted plugin operation name');
	}
	const details = snapshotAuditMetadata(metadata);
	await recordAuditLog(ctx, {
		userId: scope.userId,
		organizationId: scope.organizationId,
		pluginId: scope.pluginId,
		action: `plugin.action_${outcome}`,
		resource: 'plugin',
		resourceId: scope.pluginId,
		details: { ...details, operation, outcome },
	});
}

function snapshotAuditMetadata(value: HostedPluginAuditMetadata): HostedPluginAuditMetadata {
	if (value === null || typeof value !== 'object' || Array.isArray(value)) {
		throw new TypeError('Invalid hosted plugin audit metadata');
	}
	let descriptors: Record<PropertyKey, PropertyDescriptor>;
	let prototype: object | null;
	try {
		prototype = Object.getPrototypeOf(value);
		descriptors = Object.getOwnPropertyDescriptors(value);
	} catch {
		throw new TypeError('Invalid hosted plugin audit metadata');
	}
	if (prototype !== Object.prototype && prototype !== null) {
		throw new TypeError('Invalid hosted plugin audit metadata');
	}
	const snapshot: Record<string, boolean | number | string> = {};
	for (const key of Reflect.ownKeys(descriptors)) {
		if (typeof key !== 'string' || !AUDIT_METADATA_FIELDS.has(key)) {
			throw new TypeError('Invalid hosted plugin audit metadata');
		}
		const descriptor = descriptors[key]!;
		if (!descriptor.enumerable || !('value' in descriptor)) {
			throw new TypeError('Invalid hosted plugin audit metadata');
		}
		snapshot[key] = readMetadataValue(key, descriptor.value);
	}
	return Object.freeze(snapshot) as HostedPluginAuditMetadata;
}

function readMetadataValue(key: string, value: unknown): boolean | number | string {
	if (key === 'usageAvailable' && typeof value === 'boolean') return value;
	if (
		(key === 'attempts' || key === 'chargedMicrousd' || key === 'actualMicrousd') &&
		Number.isSafeInteger(value) &&
		(value as number) >= 0
	) {
		return value as number;
	}
	if (key === 'reasonCode' && typeof value === 'string') {
		if (HOSTED_PLUGIN_AUDIT_REASON_CODE_SET.has(value as HostedPluginAuditReasonCode)) {
			return value;
		}
	}
	throw new TypeError('Invalid hosted plugin audit metadata');
}
