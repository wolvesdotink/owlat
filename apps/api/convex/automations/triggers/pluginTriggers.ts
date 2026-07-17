import type { PluginAutomationTriggerModule } from '@owlat/plugin-kit';
import { BUNDLED_PLUGIN_AUTOMATION_TRIGGER_MODULES } from '../../plugins/automationTriggerModules.generated';
import { snapshotHostedModule } from '../../plugins/hostedModuleSnapshot';

/**
 * Runtime registry for host-composed plugin trigger modules. Trigger fanout runs
 * in a mutation, so this (and the generated modules file) must stay outside the
 * Node runtime. Each module is snapshotted to its stable `{ parseConfig, matches,
 * buildTriggerData? }` surface without invoking accessors, via the shared
 * `snapshotHostedModule` hardening the agent-step and automation-step registries
 * also use.
 */

interface GeneratedPluginTriggerModule {
	readonly kind: string;
	readonly pluginId: string;
	readonly module: unknown;
}

const GENERATED_TRIGGER_MODULES =
	BUNDLED_PLUGIN_AUTOMATION_TRIGGER_MODULES as readonly GeneratedPluginTriggerModule[];

const PLUGIN_TRIGGER_MODULES = new Map<string, PluginAutomationTriggerModule>(
	GENERATED_TRIGGER_MODULES.map((registration) => [
		registration.kind,
		snapshotHostedModule<PluginAutomationTriggerModule>(
			registration.module,
			['parseConfig', 'matches'],
			['buildTriggerData'],
			'Invalid hosted plugin automation trigger module'
		),
	])
);

export function pluginTriggerModuleFor(kind: string): PluginAutomationTriggerModule | undefined {
	return PLUGIN_TRIGGER_MODULES.get(kind);
}
