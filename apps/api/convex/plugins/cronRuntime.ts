'use node';

import {
	parsePluginId,
	PLUGIN_CRON_TIMEOUT_MAX_MS,
	PLUGIN_CRON_TIMEOUT_MIN_MS,
	type PluginCronModule,
	type PluginCronServices,
	type PluginLogFields,
	type PluginLogger,
} from '@owlat/plugin-kit';
import { v } from 'convex/values';
import { internal } from '../_generated/api';
import type { ActionCtx } from '../_generated/server';
import { internalAction } from '../_generated/server';
import { bindSystemBundledPluginLlm } from './llm';
import { pluginCronDefinition } from './cronCatalog';
import { BUNDLED_PLUGIN_CRON_MODULES } from './cronModules.generated';
import { snapshotHostedModule } from './hostedModuleSnapshot';

interface GeneratedCronModule {
	readonly kind: string;
	readonly pluginId: string;
	readonly module: unknown;
}

const CRON_MODULES = BUNDLED_PLUGIN_CRON_MODULES as readonly GeneratedCronModule[];
const MAX_LOG_MESSAGE_CODE_POINTS = 2_000;
const MAX_LOG_FIELDS_CHARS = 4_000;

type FailureReason = 'cron_failed' | 'cron_invalid' | 'cron_timeout';

/**
 * Host wrapper for one bundled plugin cron tick. Registered once per cron kind
 * by cronRegistration.ts. It rechecks the plugin's flag, grant, and env in the
 * authorization mutation, runs the handler under a wall-clock timeout with an
 * abort signal, and attributes every audit row to the plugin. It NEVER throws:
 * a disabled, ungranted, or uninstalled plugin — and any handler failure or
 * timeout — resolves to a safe no-op so the cron cannot error-loop.
 */
export const runPluginCron = internalAction({
	args: { pluginId: v.string(), cronKind: v.string() },
	handler: async (ctx, args): Promise<void> => {
		try {
			await runPluginCronTick(ctx, args.pluginId, args.cronKind);
		} catch {
			// The tick already records its own failure audit; swallow any residual
			// error (including a failed audit mutation) so the cron never loops.
		}
	},
});

async function runPluginCronTick(
	ctx: ActionCtx,
	pluginIdInput: string,
	cronKind: string
): Promise<void> {
	const definition = pluginCronDefinition(cronKind);
	if (!definition || definition.pluginId !== pluginIdInput) return;

	let pluginId;
	try {
		pluginId = parsePluginId(definition.pluginId);
	} catch {
		return;
	}

	const registrations = CRON_MODULES.filter(
		(candidate) => candidate.kind === cronKind && candidate.pluginId === definition.pluginId
	);
	if (registrations.length !== 1) return;

	const timeoutMs = boundedTimeout(definition.timeoutMs);
	if (timeoutMs === null) return;

	let authorized: boolean;
	try {
		authorized = await ctx.runMutation(internal.plugins.cronAuthorization.authorizeExecution, {
			pluginId,
			cronKind,
		});
	} catch {
		// Fail closed on an authorization outage; do not run the handler.
		return;
	}
	if (!authorized) return;

	const module = snapshotCronModule(registrations[0]!.module);
	if (!module) {
		await recordFailure(ctx, pluginId, cronKind, 'cron_invalid');
		return;
	}

	const controller = new AbortController();
	try {
		const services: PluginCronServices = Object.freeze({
			signal: controller.signal,
			logger: createCronLogger(pluginId),
			llm: bindSystemBundledPluginLlm(ctx, pluginId, controller.signal),
		});
		const work = Promise.resolve().then(() => module.run(services));
		// Promise.race observes late rejection already; this explicit drain also
		// documents that timed-out plugin work never becomes an unhandled rejection.
		void work.catch(() => undefined);
		await withTimeout(work, timeoutMs, controller);
		await ctx.runMutation(internal.plugins.cronAuthorization.recordOutcome, {
			pluginId,
			cronKind,
			outcome: 'completed',
		});
	} catch (error) {
		await recordFailure(
			ctx,
			pluginId,
			cronKind,
			error instanceof CronTimeoutError ? 'cron_timeout' : 'cron_failed'
		);
	} finally {
		// A cron gets a single host-owned lease. Completion, timeout, and failure
		// all revoke every exposed service capability (llm dispatch, abort signal).
		controller.abort();
	}
}

/**
 * Freeze the generated cron module down to its `run` contract using the shared
 * accessor-safe snapshot every hosted registry uses, so a cron module shares the
 * same `{ run, ...inert }` author contract as agent steps and automation steps.
 * Returns null (rather than throwing) on an invalid module so the tick records a
 * bounded `cron_invalid` audit row instead of erroring.
 */
function snapshotCronModule(value: unknown): PluginCronModule | null {
	try {
		return snapshotHostedModule<PluginCronModule>(value, ['run'], [], 'invalid cron module');
	} catch {
		return null;
	}
}

function createCronLogger(pluginId: string): PluginLogger {
	const prefix = `[plugin:${pluginId}]`;
	const emit =
		(level: 'debug' | 'info' | 'warn' | 'error') =>
		(message: string, fields?: PluginLogFields): void => {
			const line = `${prefix} ${truncate(String(message), MAX_LOG_MESSAGE_CODE_POINTS)}`;
			const serialized = serializeFields(fields);
			if (serialized === undefined) console[level](line);
			else console[level](line, serialized);
		};
	return Object.freeze({
		debug: emit('debug'),
		info: emit('info'),
		warn: emit('warn'),
		error: emit('error'),
	});
}

function serializeFields(fields: PluginLogFields | undefined): string | undefined {
	if (fields === undefined) return undefined;
	try {
		const json = JSON.stringify(fields);
		if (typeof json !== 'string') return undefined;
		return truncate(json, MAX_LOG_FIELDS_CHARS);
	} catch {
		return undefined;
	}
}

function truncate(value: string, maxCodePoints: number): string {
	const points = Array.from(value);
	return points.length <= maxCodePoints ? value : points.slice(0, maxCodePoints).join('');
}

function boundedTimeout(value: number): number | null {
	if (!Number.isSafeInteger(value) || value < PLUGIN_CRON_TIMEOUT_MIN_MS) return null;
	return Math.min(value, PLUGIN_CRON_TIMEOUT_MAX_MS);
}

async function withTimeout<T>(
	promise: Promise<T>,
	timeoutMs: number,
	controller: AbortController
): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([
			promise,
			new Promise<never>((_, reject) => {
				timer = setTimeout(() => {
					controller.abort();
					reject(new CronTimeoutError());
				}, timeoutMs);
			}),
		]);
	} finally {
		if (timer !== undefined) clearTimeout(timer);
	}
}

async function recordFailure(
	ctx: ActionCtx,
	pluginId: string,
	cronKind: string,
	reasonCode: FailureReason
): Promise<void> {
	await ctx
		.runMutation(internal.plugins.cronAuthorization.recordOutcome, {
			pluginId,
			cronKind,
			outcome: 'failed',
			reasonCode,
		})
		.catch(() => null);
}

class CronTimeoutError extends Error {}
