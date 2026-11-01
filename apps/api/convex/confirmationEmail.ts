/**
 * Previous-release path of `contacts/confirmationEmail.ts`. A DOI confirmation
 * mail the previous release queued for a pending signup runs as
 * `confirmationEmail:sendConfirmationEmail`. It keeps its old path, builder,
 * arguments and result shape, and runs the same body as its replacement.
 * Remove after release 0.6.17.
 */
import { internalAction } from './_generated/server';
import { sendConfirmationEmailArgs, sendDoiConfirmation } from './contacts/confirmationEmail';

/** Remove after release 0.6.17; this release schedules `contacts/confirmationEmail:sendConfirmationEmail`. */
export const sendConfirmationEmail = internalAction({
	args: sendConfirmationEmailArgs,
	handler: async (ctx, args): Promise<{ success: boolean }> => await sendDoiConfirmation(ctx, args),
});
