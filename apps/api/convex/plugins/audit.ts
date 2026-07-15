import type { PluginId } from '@owlat/plugin-kit';
import type { MutationCtx } from '../_generated/server';
import { recordAuditLog } from '../lib/auditLog';

export type HostedPluginAuditOutcome = 'completed' | 'denied' | 'failed';
export const HOSTED_PLUGIN_OPERATIONS = [
	'llm.generate',
	'storage.delete',
	'storage.get',
	'storage.list',
	'storage.set',
] as const;
export type HostedPluginOperation = (typeof HOSTED_PLUGIN_OPERATIONS)[number];
const HOSTED_PLUGIN_OPERATION_SET: ReadonlySet<HostedPluginOperation> = new Set(
	HOSTED_PLUGIN_OPERATIONS
);

export interface HostedPluginAuditMetadata {
	readonly attempts?: number;
	readonly usageAvailable?: boolean;
	readonly chargedMicrousd?: number;
	readonly actualMicrousd?: number;
	readonly reasonCode?: 'access_or_budget_denied' | 'provider_dispatch_failed';
}

export interface HostedPluginAuditScope {
	readonly organizationId: string;
	readonly pluginId: PluginId;
	readonly userId: string;
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
	scope: HostedPluginAuditScope,
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
	if (
		key === 'reasonCode' &&
		(value === 'access_or_budget_denied' || value === 'provider_dispatch_failed')
	) {
		return value;
	}
	throw new TypeError('Invalid hosted plugin audit metadata');
}
