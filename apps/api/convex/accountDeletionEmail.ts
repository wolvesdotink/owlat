/**
 * Previous-release path of `auth/accountDeletionEmail.ts`. A deletion mail the
 * previous release queued when an account scheduled its deletion runs as
 * `accountDeletionEmail:sendAccountDeletionEmail`. It keeps its old path,
 * builder, arguments and result shape, and runs the same body as its
 * replacement. Remove after release 0.6.17.
 */
import { internalAction } from './_generated/server';
import {
	sendAccountDeletionEmailArgs,
	sendDeletionConfirmation,
} from './auth/accountDeletionEmail';

/** Remove after release 0.6.17; this release schedules `auth/accountDeletionEmail:sendAccountDeletionEmail`. */
export const sendAccountDeletionEmail = internalAction({
	args: sendAccountDeletionEmailArgs,
	handler: async (ctx, args) => await sendDeletionConfirmation(ctx, args),
});
