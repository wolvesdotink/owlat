'use node';

/**
 * Hosted execution of a bundled automation step (plugin kind).
 *
 * The step walker owns retries, idempotency (the `markStepExecuting` CAS claim),
 * cancellation, and the circuit breaker. This module owns only the one thing the
 * walker cannot: turning one plugin step kind into a single authorized attempt.
 *
 * Fail closed. A denied plugin (disabled flag, ungranted capability, missing env
 * var), a malformed module result, or a thrown error all become a `failed`
 * StepOutcome — the walker then retries and finally cancels the run. A plugin can
 * make a step fail; it can never force it to complete or advance.
 */

import {
	applyPluginUntrustedTextPolicy,
	createPluginHost,
	type PluginUntrustedTextPolicy,
} from '@owlat/plugin-host';
import {
	parsePluginId,
	PLUGIN_AUTOMATION_STEP_CAPABILITY,
	type PluginAutomationStepInput,
	type PluginAutomationStepModule,
	type PluginAutomationStepResult,
	type PluginId,
} from '@owlat/plugin-kit';
import { internal } from '../../_generated/api';
import type { ActionCtx } from '../../_generated/server';
import type { Doc } from '../../_generated/dataModel';
import { isEnvPresent } from '../../lib/env';
import { getBundledPluginManifest } from '../../plugins/authorization';
import { snapshotHostedModule } from '../../plugins/hostedModuleSnapshot';
import { BUNDLED_PLUGIN_AUTOMATION_STEP_MODULES } from '../../plugins/automationStepModules.generated';
import { pluginStepCatalogEntry } from './catalog';
import type { StepOutcome } from '../types';

const MAX_FAILURE_REASON_CODE_POINTS = 200;

/**
 * A plugin step failure reason is untrusted text. It is only surfaced on the
 * step-run's host-owned `errorMessage`, never fed to a prompt, so the policy
 * just clamps length and strips control characters — no injection scrubbing is
 * meaningful for a non-prompt sink, but the boundary is still enforced.
 */
function stripControlCharacters(text: string): string {
	let out = '';
	for (const character of text) {
		const codePoint = character.codePointAt(0) ?? 0;
		out += codePoint < 0x20 || codePoint === 0x7f ? ' ' : character;
	}
	return out;
}

const FAILURE_REASON_POLICY: PluginUntrustedTextPolicy = Object.freeze({
	maximumCodePoints: MAX_FAILURE_REASON_CODE_POINTS,
	scrubPromptInjection: stripControlCharacters,
});

/**
 * Host-owned deadline for one plugin step `execute`. A plugin step runs inside
 * the retrying walker, so a never-resolving module would otherwise strand the
 * step in `executing` until the platform kills the action — with no failure for
 * the retry chain to advance on. Racing the module against this deadline yields a
 * `failed` StepOutcome the walker retries and finally cancels; the orphaned work
 * cannot force the run to complete. Mirrors the draft-strategy / autonomy-gate
 * clamp (the step module contract carries no `AbortSignal`, so the host stops
 * waiting rather than aborting the module).
 */
const MAX_PLUGIN_STEP_EXECUTION_MS = 30_000;

class PluginStepTimeoutError extends Error {
	constructor() {
		super('Plugin automation step timed out');
		this.name = 'PluginStepTimeoutError';
	}
}

async function withExecutionDeadline<T>(work: Promise<T>, timeoutMs: number): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([
			work,
			new Promise<never>((_, reject) => {
				timer = setTimeout(() => reject(new PluginStepTimeoutError()), timeoutMs);
			}),
		]);
	} finally {
		if (timer !== undefined) clearTimeout(timer);
	}
}

interface GeneratedPluginStepModule {
	readonly kind: string;
	readonly pluginId: string;
	readonly module: unknown;
}

const GENERATED_STEP_MODULES =
	BUNDLED_PLUGIN_AUTOMATION_STEP_MODULES as readonly GeneratedPluginStepModule[];

const PLUGIN_STEP_MODULES = new Map<string, PluginAutomationStepModule>(
	GENERATED_STEP_MODULES.map((registration) => [
		registration.kind,
		snapshotHostedModule<PluginAutomationStepModule>(
			registration.module,
			['parseConfig', 'execute'],
			[],
			'Invalid hosted plugin automation step module'
		),
	])
);

/** Bounded contact snapshot; the plugin never receives the raw Convex row or ids. */
function buildPluginStepInput(contact: Doc<'contacts'>): PluginAutomationStepInput {
	const properties: Record<string, string | number | boolean | null> = {};
	for (const field of ['firstName', 'lastName', 'source', 'timezone', 'language'] as const) {
		const value = contact[field];
		if (typeof value === 'string') properties[field] = value;
	}
	properties['hasOpened'] = contact.hasOpened === true;
	properties['hasClicked'] = contact.hasClicked === true;
	return Object.freeze({
		contactEmail: contact.email ?? '',
		contactProperties: Object.freeze(properties),
	});
}

function parsePluginStepResult(value: unknown, pluginId: PluginId): PluginAutomationStepResult {
	if (value === null || typeof value !== 'object') {
		throw new TypeError('Plugin automation step returned a non-object result');
	}
	const kind = (value as { kind?: unknown }).kind;
	if (kind === 'completed') return { kind: 'completed' };
	if (kind === 'failed') {
		const rawReason = (value as { reason?: unknown }).reason;
		const reason = applyPluginUntrustedTextPolicy(
			pluginId,
			typeof rawReason === 'string' ? rawReason : 'Plugin automation step reported a failure',
			FAILURE_REASON_POLICY
		);
		return { kind: 'failed', reason };
	}
	throw new TypeError('Plugin automation step returned an unknown result kind');
}

/**
 * Execute one authorized plugin automation step. Returns a `StepOutcome` the
 * walker maps onto the run exactly as it does for core steps.
 */
export async function executePluginStep(
	ctx: ActionCtx,
	step: Doc<'automationSteps'>,
	contact: Doc<'contacts'>
): Promise<StepOutcome> {
	const entry = pluginStepCatalogEntry(step.stepType);
	if (!entry) {
		return { status: 'failed', error: `Unknown plugin automation step kind: ${step.stepType}` };
	}
	// The catalog entry's id came from a validated manifest at codegen time; parse
	// it once into the branded `PluginId` the host services require, so no call
	// site has to launder an unbranded string through `as never`.
	const pluginId = parsePluginId(entry.pluginId);
	const module = PLUGIN_STEP_MODULES.get(step.stepType);
	if (!module) {
		return { status: 'failed', error: 'Plugin automation step module is not registered' };
	}

	const authorized = await ctx.runMutation(
		internal.plugins.automationStepAuthorization.authorizeExecution,
		{ pluginId: entry.pluginId, stepKind: step.stepType }
	);
	if (!authorized) {
		// Fail closed: a disabled flag or ungranted capability is a failure, not a skip.
		return { status: 'failed', error: 'Plugin automation step access denied' };
	}

	const host = createPluginHost({
		manifest: getBundledPluginManifest(pluginId),
		capabilityGrants: [{ capability: PLUGIN_AUTOMATION_STEP_CAPABILITY, granted: true }],
		featureFlags: { isEnabled: () => true },
		environment: { isPresent: isEnvPresent },
		untrustedText: FAILURE_REASON_POLICY,
	});

	const rawConfig =
		step.config && typeof step.config === 'object' && 'pluginConfig' in step.config
			? (step.config as { pluginConfig: unknown }).pluginConfig
			: {};

	let result: PluginAutomationStepResult;
	try {
		result = await host.run(PLUGIN_AUTOMATION_STEP_CAPABILITY, async () => {
			const config = module.parseConfig(rawConfig);
			const moduleResult = await withExecutionDeadline(
				module.execute(buildPluginStepInput(contact), config),
				MAX_PLUGIN_STEP_EXECUTION_MS
			);
			return parsePluginStepResult(moduleResult, pluginId);
		});
	} catch {
		await recordOutcome(ctx, entry.pluginId, step.stepType, false);
		return { status: 'failed', error: 'Plugin automation step failed' };
	}

	if (result.kind === 'completed') {
		await recordOutcome(ctx, entry.pluginId, step.stepType, true);
		return { status: 'completed' };
	}
	await recordOutcome(ctx, entry.pluginId, step.stepType, false);
	return { status: 'failed', error: result.reason };
}

async function recordOutcome(
	ctx: ActionCtx,
	pluginId: string,
	stepKind: string,
	success: boolean
): Promise<void> {
	await ctx
		.runMutation(internal.plugins.automationStepAuthorization.recordOutcome, {
			pluginId,
			stepKind,
			success,
		})
		// The step already executed; a failing audit write must not fail it (a
		// plugin cannot be denied a completed run by knocking over audit). But the
		// silence still needs a signal — log fixed taxonomy only (plugin id, kind,
		// success), never untrusted text.
		.catch(() => {
			console.warn('plugin automation step audit write failed', {
				pluginId,
				stepKind,
				success,
			});
		});
}
