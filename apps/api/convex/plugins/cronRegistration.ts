import {
	PLUGIN_CRON_MAX_INTERVAL_MINUTES,
	PLUGIN_CRON_MIN_INTERVAL_MINUTES,
} from '@owlat/plugin-kit';
import type { cronJobs } from 'convex/server';
import { internal } from '../_generated/api';
import { CRON_CATALOG, type HostedCronDefinition } from './cronCatalog';

type Crons = ReturnType<typeof cronJobs>;

export interface PluginCronRegistration {
	/** Unique Convex cron identifier; equals the namespaced cron kind. */
	readonly name: string;
	readonly intervalMinutes: number;
	readonly pluginId: string;
	readonly cronKind: string;
}

/**
 * Derive the ordered, de-duplicated set of plugin cron registrations from the
 * generated catalog. Registration is idempotent: a kind (which is also the
 * unique registration name) is registered at most once, and each interval is
 * clamped into the host scheduling limits so a stale or hand-edited catalog can
 * never register a hot loop or an effectively-never cron. Any entry that cannot
 * be represented as a bounded interval is skipped rather than allowed to break
 * core cron registration.
 */
export function planPluginCronRegistrations(
	catalog: readonly HostedCronDefinition[]
): readonly PluginCronRegistration[] {
	const seen = new Set<string>();
	const registrations: PluginCronRegistration[] = [];
	for (const definition of catalog) {
		if (
			typeof definition.kind !== 'string' ||
			typeof definition.pluginId !== 'string' ||
			definition.pluginId.length === 0
		) {
			continue;
		}
		// The name must be the collision-safe namespaced kind with a non-empty
		// local id, so a plugin cron can never be registered under a bare or
		// core-shadowing name.
		const prefix = `plugin.${definition.pluginId}.`;
		if (!definition.kind.startsWith(prefix) || definition.kind.length <= prefix.length) continue;
		if (seen.has(definition.kind)) continue;
		const intervalMinutes = clampInterval(definition.intervalMinutes);
		if (intervalMinutes === null) continue;
		seen.add(definition.kind);
		registrations.push(
			Object.freeze({
				name: definition.kind,
				intervalMinutes,
				pluginId: definition.pluginId,
				cronKind: definition.kind,
			})
		);
	}
	return Object.freeze(registrations);
}

function clampInterval(value: number): number | null {
	if (!Number.isFinite(value)) return null;
	const rounded = Math.round(value);
	if (!Number.isSafeInteger(rounded)) return null;
	return Math.min(
		Math.max(rounded, PLUGIN_CRON_MIN_INTERVAL_MINUTES),
		PLUGIN_CRON_MAX_INTERVAL_MINUTES
	);
}

/**
 * Append every bundled plugin cron to the shared cron table, each wrapped in
 * the host runtime action so flag/grant/env are rechecked at execution time and
 * every run is attributed to its plugin. Named by the collision-safe cron kind,
 * so a plugin cron can never shadow a core cron.
 */
export function registerBundledPluginCrons(crons: Crons): void {
	for (const registration of planPluginCronRegistrations(CRON_CATALOG)) {
		crons.interval(
			registration.name,
			{ minutes: registration.intervalMinutes },
			internal.plugins.cronRuntime.runPluginCron,
			{ pluginId: registration.pluginId, cronKind: registration.cronKind }
		);
	}
}
