import type { PluginAutomationTriggerModule } from '@owlat/plugin-kit';
import { BUNDLED_PLUGIN_AUTOMATION_TRIGGER_MODULES } from '../../plugins/automationTriggerModules.generated';

/**
 * Runtime registry for host-composed plugin trigger modules. Trigger fanout runs
 * in a mutation, so this (and the generated modules file) must stay outside the
 * Node runtime. Each module is snapshotted to its stable `{ parseConfig, matches,
 * buildTriggerData? }` surface without invoking accessors, mirroring the agent
 * step module hardening in `agent/steps/index.ts`.
 */

interface GeneratedPluginTriggerModule {
	readonly kind: string;
	readonly pluginId: string;
	readonly module: unknown;
}

const GENERATED_TRIGGER_MODULES =
	BUNDLED_PLUGIN_AUTOMATION_TRIGGER_MODULES as readonly GeneratedPluginTriggerModule[];

function ownFunction(value: object, field: string): ((...args: never[]) => unknown) | undefined {
	const descriptor = Object.getOwnPropertyDescriptor(value, field);
	return descriptor && 'value' in descriptor && typeof descriptor.value === 'function'
		? descriptor.value
		: undefined;
}

function snapshotPluginTriggerModule(value: unknown): PluginAutomationTriggerModule {
	if (value === null || typeof value !== 'object' || Array.isArray(value)) {
		throw new TypeError('Invalid hosted plugin automation trigger module');
	}
	const parseConfig = ownFunction(value, 'parseConfig');
	const matches = ownFunction(value, 'matches');
	if (!parseConfig || !matches) {
		throw new TypeError('Invalid hosted plugin automation trigger module');
	}
	const buildTriggerData = ownFunction(value, 'buildTriggerData');
	return Object.freeze({
		parseConfig,
		matches,
		...(buildTriggerData ? { buildTriggerData } : {}),
	}) as PluginAutomationTriggerModule;
}

const PLUGIN_TRIGGER_MODULES = new Map<string, PluginAutomationTriggerModule>(
	GENERATED_TRIGGER_MODULES.map((registration) => [
		registration.kind,
		snapshotPluginTriggerModule(registration.module),
	])
);

export function pluginTriggerModuleFor(kind: string): PluginAutomationTriggerModule | undefined {
	return PLUGIN_TRIGGER_MODULES.get(kind);
}
