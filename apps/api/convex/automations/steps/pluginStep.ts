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
	PLUGIN_AUTOMATION_STEP_CAPABILITY,
	type PluginAutomationStepInput,
	type PluginAutomationStepModule,
	type PluginAutomationStepResult,
} from '@owlat/plugin-kit';
import { internal } from '../../_generated/api';
import type { ActionCtx } from '../../_generated/server';
import type { Doc } from '../../_generated/dataModel';
import { isEnvPresent } from '../../lib/env';
import { getBundledPluginManifest } from '../../plugins/authorization';
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

interface GeneratedPluginStepModule {
	readonly kind: string;
	readonly pluginId: string;
	readonly module: unknown;
}

const GENERATED_STEP_MODULES =
	BUNDLED_PLUGIN_AUTOMATION_STEP_MODULES as readonly GeneratedPluginStepModule[];

/** Extract `{ parseConfig, execute }` from a generated module without invoking accessors. */
function snapshotPluginStepModule(value: unknown): PluginAutomationStepModule {
	if (value === null || typeof value !== 'object' || Array.isArray(value)) {
		throw new TypeError('Invalid hosted plugin automation step module');
	}
	const parseConfig = Object.getOwnPropertyDescriptor(value, 'parseConfig');
	const execute = Object.getOwnPropertyDescriptor(value, 'execute');
	if (
		!parseConfig ||
		!('value' in parseConfig) ||
		typeof parseConfig.value !== 'function' ||
		!execute ||
		!('value' in execute) ||
		typeof execute.value !== 'function'
	) {
		throw new TypeError('Invalid hosted plugin automation step module');
	}
	return Object.freeze({ parseConfig: parseConfig.value, execute: execute.value });
}

const PLUGIN_STEP_MODULES = new Map<string, PluginAutomationStepModule>(
	GENERATED_STEP_MODULES.map((registration) => [
		registration.kind,
		snapshotPluginStepModule(registration.module),
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

function parsePluginStepResult(value: unknown, pluginId: string): PluginAutomationStepResult {
	if (value === null || typeof value !== 'object') {
		throw new TypeError('Plugin automation step returned a non-object result');
	}
	const kind = (value as { kind?: unknown }).kind;
	if (kind === 'completed') return { kind: 'completed' };
	if (kind === 'failed') {
		const rawReason = (value as { reason?: unknown }).reason;
		const reason = applyPluginUntrustedTextPolicy(
			pluginId as never,
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
		manifest: getBundledPluginManifest(entry.pluginId as never),
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
			const moduleResult = await module.execute(buildPluginStepInput(contact), config);
			return parsePluginStepResult(moduleResult, entry.pluginId);
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
		.catch(() => undefined);
}
