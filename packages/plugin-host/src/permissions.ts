import type {
	PluginCapability,
	PluginCapabilityGrant,
	PluginId,
	PluginPermissionService,
} from '@owlat/plugin-kit';
import { PluginHostError } from './errors';

export interface PluginPermissionPolicy {
	readonly pluginId: PluginId;
	readonly declaredCapabilities: readonly PluginCapability[];
	readonly grants: readonly PluginCapabilityGrant[];
}

/**
 * Build a fail-closed permission service. A grant can enable only a capability
 * requested by the manifest; missing and explicit false grants both deny.
 */
export function createPluginPermissionService(
	policy: PluginPermissionPolicy
): PluginPermissionService {
	const pluginId = policy.pluginId;
	const declared = new Set(policy.declaredCapabilities);
	const granted = new Set<PluginCapability>();
	const configured = new Set<PluginCapability>();

	for (const configuredGrant of policy.grants) {
		const grant = readCapabilityGrant(pluginId, configuredGrant);
		if (!declared.has(grant.capability)) {
			throw new PluginHostError(
				'invalid_capability_grant',
				`Plugin ${pluginId} did not declare capability ${grant.capability}`,
				{ pluginId, capability: grant.capability }
			);
		}
		if (configured.has(grant.capability)) {
			throw new PluginHostError(
				'invalid_capability_grant',
				`Plugin ${pluginId} has more than one grant for ${grant.capability}`,
				{ pluginId, capability: grant.capability }
			);
		}

		configured.add(grant.capability);
		if (grant.granted) granted.add(grant.capability);
	}

	return Object.freeze({
		has(capability: PluginCapability): boolean {
			return declared.has(capability) && granted.has(capability);
		},
		require(capability: PluginCapability): void {
			if (!declared.has(capability)) {
				throw new PluginHostError(
					'capability_not_declared',
					`Plugin ${pluginId} did not declare capability ${capability}`,
					{ pluginId, capability }
				);
			}
			if (!granted.has(capability)) {
				throw new PluginHostError(
					'capability_not_granted',
					`Plugin ${pluginId} is not granted capability ${capability}`,
					{ pluginId, capability }
				);
			}
		},
	});
}

function readCapabilityGrant(
	pluginId: PluginId,
	grant: PluginCapabilityGrant
): PluginCapabilityGrant {
	if (grant === null || typeof grant !== 'object') return invalidCapabilityGrant(pluginId);
	const keys = Reflect.ownKeys(grant);
	const capability = Object.getOwnPropertyDescriptor(grant, 'capability');
	const granted = Object.getOwnPropertyDescriptor(grant, 'granted');
	if (
		keys.length !== 2 ||
		!capability ||
		!('value' in capability) ||
		typeof capability.value !== 'string' ||
		!isCapabilityShaped(capability.value) ||
		!granted ||
		!('value' in granted) ||
		typeof granted.value !== 'boolean'
	) {
		return invalidCapabilityGrant(pluginId);
	}
	return { capability: capability.value, granted: granted.value };
}

function isCapabilityShaped(value: string): value is PluginCapability {
	const separator = value.indexOf(':');
	return separator > 0 && separator < value.length - 1;
}

function invalidCapabilityGrant(pluginId: PluginId): never {
	throw new PluginHostError(
		'invalid_capability_grant',
		`Plugin ${pluginId} has a malformed capability grant`,
		{ pluginId }
	);
}
