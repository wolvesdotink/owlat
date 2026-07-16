import type { PluginLlmService, PluginLogger } from './context';
import type { PluginId } from './pluginId';
import type { PluginStaticModuleExport } from './sendTransport';

/** Capability assigned by the host to every bundled plugin cron. */
export const PLUGIN_CRON_CAPABILITY = 'scheduler:cron' as const;

export type PluginCronCapability = typeof PLUGIN_CRON_CAPABILITY;

/**
 * Scheduling limits the host enforces on plugin crons at manifest validation,
 * codegen, and registration. A plugin can add background work but can never
 * schedule a hot loop or an effectively-never cron: the interval is clamped to
 * this closed range before any cron is registered.
 */
export const PLUGIN_CRON_MIN_INTERVAL_MINUTES = 15;
export const PLUGIN_CRON_MAX_INTERVAL_MINUTES = 28 * 24 * 60; // 40320 (four weeks)

/** Host-enforced wall-clock bounds for a single cron execution. */
export const PLUGIN_CRON_TIMEOUT_MIN_MS = 1_000;
export const PLUGIN_CRON_TIMEOUT_MAX_MS = 5 * 60_000; // 300000

/** Local contribution identity. The host namespaces it with the owning plugin id. */
export type PluginCronLocalId = string;

/** Collision-safe cron kind used as the unique Convex cron registration name. */
export type PluginCronKind = `plugin.${PluginId}.${PluginCronLocalId}`;

/** Fixed-interval schedule; the only shape a bundled plugin cron may request. */
export interface PluginCronSchedule {
	/** Whole minutes between runs, clamped to the host scheduling limits. */
	readonly intervalMinutes: number;
}

/** Data-only manifest descriptor. Executable code lives at `module.exportPath`. */
export interface PluginCronDefinition {
	readonly id: PluginCronLocalId;
	readonly label: string;
	readonly module: PluginStaticModuleExport;
	readonly schedule: PluginCronSchedule;
	/** Host-enforced wall-clock limit for one execution. */
	readonly timeoutMs: number;
}

/**
 * Services supplied by the host to one cron execution. A cron receives no raw
 * Convex context, tenant id, or credential; cancellation is cooperative through
 * `signal`, and LLM access is the attributed, budgeted host dispatch.
 */
export interface PluginCronServices {
	readonly signal: AbortSignal;
	readonly logger: PluginLogger;
	readonly llm: PluginLlmService;
}

export interface PluginCronModule {
	run(services: PluginCronServices): Promise<void>;
}

export function pluginCronKind(pluginId: PluginId, localId: string): PluginCronKind {
	return `plugin.${pluginId}.${localId}`;
}
