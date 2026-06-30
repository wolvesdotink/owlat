import type { ActionCtx } from '../../../_generated/server';
import { internal } from '../../../_generated/api';
import type { Condition } from '../../../conditions';
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
		const conditionRaw = r['condition'] as Record<string, unknown>;
		if (typeof conditionRaw['kind'] !== 'string') {
			throw new Error('condition step: condition is missing `kind`');
		}
		// Inner-condition shape validation happens when the step evaluates,
		// via the conditions registry's `parseCondition`.
		return {
			condition: conditionRaw as unknown as Condition,
			yesBranchStepIndex:
				typeof r['yesBranchStepIndex'] === 'number' ? r['yesBranchStepIndex'] : null,
			noBranchStepIndex:
				typeof r['noBranchStepIndex'] === 'number' ? r['noBranchStepIndex'] : null,
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
			return { status: 'failed', error: result.reason };
		}

		const branchTarget = result.result ? config.yesBranchStepIndex : config.noBranchStepIndex;
		return branchTarget !== null && branchTarget !== undefined
			? { status: 'completed', nextStepIndex: branchTarget }
			: { status: 'completed' };
	},
};
