/**
 * Previous-release paths of `agent/configMutations.ts`. The AI replies page in
 * a tab opened before the deploy still reads the config and saves the tuning
 * and reply mode through `agentConfigMutations:*` by path. Each function keeps
 * its old path, builder, auth floor, arguments and result shape, and runs the
 * same body as its replacement. Remove after release 0.6.17.
 */
import { v } from 'convex/values';
import { publicQuery, adminMutation } from './lib/authedFunctions';
import { isActiveOrgMember } from './lib/sessionOrganization';
import { optionalFields, pick } from './lib/validators/fields';
import { agentConfigFields } from './schema/autonomy';
import { readAgentConfig, writeAgentConfig, writeReplyMode } from './agent/configMutations';

/** Remove after release 0.6.17; this release calls `agent/configMutations:getConfig`. */
export const getConfig = publicQuery({
	// public: soft-auth — org members only; returns null for anonymous/non-members
	args: {},
	handler: async (ctx) => {
		if (!(await isActiveOrgMember(ctx))) return null;
		return await readAgentConfig(ctx);
	},
});

/** Remove after release 0.6.17; this release calls `agent/configMutations:updateConfig`. */
export const updateConfig = adminMutation({
	// The same thirteen optional tuning fields as the moved function.
	args: optionalFields(
		pick(agentConfigFields, [
			'confidenceThreshold',
			'toneDescription',
			'signatureTemplate',
			'maxDailyAutoReplies',
			'coalesceWindowMs',
			'autoSendDelayMs',
			'humanApproveUndoDelayMs',
			'isWorkingHoursEnabled',
			'workingHoursTimezone',
			'workingHoursStart',
			'workingHoursEnd',
			'workingHoursDays',
			'isItemCoverageEnforced',
		])
	),
	handler: async (ctx, args, { userId }) => await writeAgentConfig(ctx, args, userId),
});

/** Remove after release 0.6.17; this release calls `agent/configMutations:setReplyMode`. */
export const setReplyMode = adminMutation({
	args: { mode: v.union(v.literal('draft'), v.literal('auto')) },
	returns: v.null(),
	handler: async (ctx, args, session) => {
		await writeReplyMode(ctx, args.mode, session.userId);
		return null;
	},
});
