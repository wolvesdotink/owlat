/**
 * Tier-1 automation trigger contribution (`automationTriggers`).
 *
 * The host fires plugin triggers with a bounded `{ contactId, payload }` and the
 * operator-persisted config. `parseConfig` is the sole unknown-input boundary:
 * it must reject anything it does not fully understand (the host treats a throw
 * as "do not start this automation"), and `matches` must then be a pure
 * predicate over already-validated data.
 */

import type {
	PluginAutomationTriggerData,
	PluginAutomationTriggerInput,
	PluginAutomationTriggerModule,
} from '@owlat/plugin-kit';
import { meetsLevel, type EscalationLevel } from './detector';

export const ESCALATION_TRIGGER_LOCAL_ID = 'escalation-raised';

/** Validated trigger config: the minimum severity that starts the automation. */
export interface EscalationTriggerConfig {
	readonly minimumLevel: Exclude<EscalationLevel, 'none'>;
}

export class EscalationConfigError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'EscalationConfigError';
	}
}

function readOwnValue(raw: object, key: string): unknown {
	const descriptor = Object.getOwnPropertyDescriptor(raw, key);
	return descriptor && 'value' in descriptor ? descriptor.value : undefined;
}

/**
 * Strictly parse an operator-persisted config. Accepts ONLY a plain object with
 * a `minimumLevel` of `watch` or `escalate`; a getter, an inherited property, an
 * array, or an unknown level all throw.
 */
export function parseEscalationTriggerConfig(raw: unknown): EscalationTriggerConfig {
	if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
		throw new EscalationConfigError('Escalation trigger config must be a plain object');
	}
	const prototype = Object.getPrototypeOf(raw);
	if (prototype !== Object.prototype && prototype !== null) {
		throw new EscalationConfigError('Escalation trigger config must be a plain object');
	}
	const minimumLevel = readOwnValue(raw, 'minimumLevel');
	if (minimumLevel !== 'watch' && minimumLevel !== 'escalate') {
		throw new EscalationConfigError(
			'Escalation trigger config requires minimumLevel of "watch" or "escalate"'
		);
	}
	return { minimumLevel };
}

/** Read the level from an untrusted firing payload; anything unknown is `none`. */
function payloadLevel(input: PluginAutomationTriggerInput): EscalationLevel {
	const value = readOwnValue(input.payload, 'level');
	return value === 'watch' || value === 'escalate' || value === 'none' ? value : 'none';
}

function payloadSignalCount(input: PluginAutomationTriggerInput): number {
	const value = readOwnValue(input.payload, 'signals');
	return Array.isArray(value) ? value.length : 0;
}

export const escalationTrigger: PluginAutomationTriggerModule<EscalationTriggerConfig> = {
	parseConfig: parseEscalationTriggerConfig,

	matches(input: PluginAutomationTriggerInput, config: EscalationTriggerConfig): boolean {
		return meetsLevel(payloadLevel(input), config.minimumLevel);
	},

	/** Primitives only — the host rejects nested objects in trigger data. */
	buildTriggerData(input: PluginAutomationTriggerInput): PluginAutomationTriggerData {
		return {
			escalationLevel: payloadLevel(input),
			escalationSignalCount: payloadSignalCount(input),
		};
	},
};
