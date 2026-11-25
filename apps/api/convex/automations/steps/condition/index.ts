import type { ActionCtx } from '../../../_generated/server';
import { internal } from '../../../_generated/api';
import { parseCondition, type Condition } from '../../../conditions';
import type { StepExecuteArgs, StepModule, StepOutcome } from '../../types';

export interface ConditionStepConfig {
	condition: Condition;
	yesBranchStepIndex: number | null;
	noBranchStepIndex: number | null;
}

export const conditionStepModule: StepModule<'condition', ConditionStepConfig> = {
	kind: 'condition',
	parseConfig(raw) {
		if (!raw || typeof raw !== 'object') {
			throw new Error('condition step: config must be an object');
		}
		const r = raw as Record<string, unknown>;
		if (!r['condition'] || typeof r['condition'] !== 'object') {
			throw new Error('condition step: missing `condition`');
		}
		// The inner condition is parsed here, not first in the evaluating query, so a
		// condition that does not parse fails the step as `invalid_step_config`.
		return {
			condition: parseCondition(r['condition']),
			yesBranchStepIndex:
				typeof r['yesBranchStepIndex'] === 'number' ? r['yesBranchStepIndex'] : null,
			noBranchStepIndex: typeof r['noBranchStepIndex'] === 'number' ? r['noBranchStepIndex'] : null,
		};
	},
	async execute(ctx: ActionCtx, args: StepExecuteArgs<ConditionStepConfig>): Promise<StepOutcome> {
		const { config, contact } = args;
		const result = await ctx.runQuery(
			internal.automations.steps.condition.queries.evaluateConditionForContact,
			{
				contactId: contact._id,
				conditionJson: JSON.stringify(config.condition),
			}
		);

		if (!result.ok) {
			return { status: 'failed', reason: 'unknown', error: result.reason };
		}

		const branchTarget = result.result ? config.yesBranchStepIndex : config.noBranchStepIndex;
		return branchTarget !== null && branchTarget !== undefined
			? { status: 'completed', nextStepIndex: branchTarget }
			: { status: 'completed' };
	},
};
