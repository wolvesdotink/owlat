/** A host-mediated operation a plugin may request. */
export type PluginCapability = `${string}:${string}`;

/** An operator decision allowing one declared capability at runtime. */
export interface PluginCapabilityGrant {
	readonly capability: PluginCapability;
	readonly granted: boolean;
}

/**
 * Capability checks over one plugin's declared and granted capabilities. The host
 * builds one for its own checks (`@owlat/plugin-host`). Plugin code does not
 * receive one yet: it belongs to the planned `PluginContext`.
 */
export interface PluginPermissionService {
	has(capability: PluginCapability): boolean;
	require(capability: PluginCapability): void;
}
