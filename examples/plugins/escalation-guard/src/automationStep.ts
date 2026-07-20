/**
 * Tier-1 automation step contribution (`automationSteps`).
 *
 * This step records that a human owner has been assigned to an escalation. It
 * demonstrates the terminal semantics of the step contract, which are the point
 * of the example: a plugin step may return `completed` or `failed` and NOTHING
 * else. `failed` is retryable by the host exactly like a thrown error, so a
 * plugin can never force an automation run to advance past a precondition it
 * does not actually satisfy, and it can never branch the run itself.
 */

import type {
	PluginAutomationStepInput,
	PluginAutomationStepModule,
	PluginAutomationStepResult,
} from '@owlat/plugin-kit';
import { assertPlainObject, EscalationConfigError, readOwnValue } from './config';

export const ASSIGN_OWNER_STEP_LOCAL_ID = 'require-owner';

/** Maximum length of the contact property name an operator may point the step at. */
export const MAX_PROPERTY_KEY_LENGTH = 64;

export interface RequireOwnerConfig {
	/** Contact property that must hold a non-empty owner before the run continues. */
	readonly ownerProperty: string;
}

const PROPERTY_KEY = /^[A-Za-z][A-Za-z0-9_]*$/;

export function parseRequireOwnerConfig(raw: unknown): RequireOwnerConfig {
	assertPlainObject(raw, 'Require-owner config must be a plain object');
	const ownerProperty = readOwnValue(raw, 'ownerProperty');
	if (
		typeof ownerProperty !== 'string' ||
		ownerProperty.length > MAX_PROPERTY_KEY_LENGTH ||
		!PROPERTY_KEY.test(ownerProperty)
	) {
		throw new EscalationConfigError(
			'Require-owner config requires an alphanumeric ownerProperty name'
		);
	}
	return { ownerProperty };
}

export const requireOwnerStep: PluginAutomationStepModule<RequireOwnerConfig> = {
	parseConfig: parseRequireOwnerConfig,

	async execute(
		input: PluginAutomationStepInput,
		config: RequireOwnerConfig
	): Promise<PluginAutomationStepResult> {
		const owner = readOwnValue(input.contactProperties, config.ownerProperty);
		if (typeof owner === 'string' && owner.trim().length > 0) {
			return { kind: 'completed' };
		}
		return {
			kind: 'failed',
			reason: `Contact has no ${config.ownerProperty}; assign an escalation owner before continuing.`,
		};
	},
};
