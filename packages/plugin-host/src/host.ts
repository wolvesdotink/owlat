import {
	parsePluginManifest,
	type PluginCapability,
	type PluginCapabilityGrant,
	type PluginManifest,
	type PluginPermissionService,
} from '@owlat/plugin-kit';
import type { PluginFeatureFlagService } from './featureFlags';
import { runWithPluginFeatureFlag } from './featureFlags';
import { snapshotPluginManifest } from './manifestSnapshot';
import { createPluginPermissionService } from './permissions';
import type { PluginUntrustedTextPolicy } from './untrustedText';
import { applyPluginUntrustedTextPolicy, validateUntrustedTextPolicy } from './untrustedText';

export interface CreatePluginHostOptions {
	readonly manifest: unknown;
	readonly capabilityGrants: readonly PluginCapabilityGrant[];
	readonly featureFlags: PluginFeatureFlagService;
	readonly untrustedText: PluginUntrustedTextPolicy;
}

export interface PluginHost {
	readonly manifest: PluginManifest;
	readonly permissions: PluginPermissionService;
	run<Result>(
		requiredCapability: PluginCapability,
		operation: () => Result | Promise<Result>
	): Promise<Result>;
	runUntrustedText(
		requiredCapability: PluginCapability,
		operation: () => string | Promise<string>
	): Promise<string>;
	protectUntrustedText(text: string): string;
}

/** Central policy boundary for statically composed plugin operations. */
export function createPluginHost(options: CreatePluginHostOptions): PluginHost {
	const manifest = snapshotPluginManifest(parsePluginManifest(options.manifest));
	const pluginId = manifest.id;
	const featureFlags = options.featureFlags;
	const untrustedText = Object.freeze({ ...options.untrustedText });
	validateUntrustedTextPolicy(pluginId, untrustedText);
	const permissions = createPluginPermissionService({
		pluginId,
		declaredCapabilities: manifest.capabilities,
		grants: options.capabilityGrants,
	});

	async function run<Result>(
		requiredCapability: PluginCapability,
		operation: () => Result | Promise<Result>
	): Promise<Result> {
		return runWithPluginFeatureFlag(featureFlags, pluginId, () => {
			permissions.require(requiredCapability);
			return operation();
		});
	}

	function protectUntrustedText(text: string): string {
		return applyPluginUntrustedTextPolicy(pluginId, text, untrustedText);
	}

	return Object.freeze({
		manifest,
		permissions,
		run,
		async runUntrustedText(
			requiredCapability: PluginCapability,
			operation: () => string | Promise<string>
		): Promise<string> {
			return protectUntrustedText(await run(requiredCapability, operation));
		},
		protectUntrustedText,
	});
}
