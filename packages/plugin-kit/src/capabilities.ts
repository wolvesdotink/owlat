/** A host-mediated operation a plugin may request. */
export type PluginCapability = `${string}:${string}`;

/** An operator decision allowing one declared capability at runtime. */
export interface PluginCapabilityGrant {
	readonly capability: PluginCapability;
	readonly granted: boolean;
}

/** Capability checks exposed to hosted plugin code. */
export interface PluginPermissionService {
	has(capability: PluginCapability): boolean;
	require(capability: PluginCapability): void;
}
