/**
 * Previous-release path of `contacts/confirmationEmailQueries.ts`. A DOI
 * confirmation mail or delivery test the previous release has mid-run reads the
 * default sender through `confirmationEmailQueries:getTeamInfo`. It keeps its
 * old path, builder, arguments and result shape, and runs the same body as its
 * replacement. Remove after release 0.6.17.
 */
import { internalQuery } from './_generated/server';
import { readTeamInfo } from './contacts/confirmationEmailQueries';

/** Remove after release 0.6.17; this release calls `contacts/confirmationEmailQueries:getTeamInfo`. */
export const getTeamInfo = internalQuery({
	args: {},
	handler: async (ctx) => await readTeamInfo(ctx),
});
