'use node';

/**
 * Previous-release paths of `maintenance/systemMail.ts`. A previous-release
 * action still running when this one deploys (an auth or invitation hook, a
 * double opt-in or account-deletion send, a checklist alert or loopback test,
 * a delivery status probe) sends through `systemMail:sendSystemEmail` or
 * `systemMail:trySendSystemEmail` by path. Each keeps its old path, builder,
 * arguments and result shape, and runs the same body as its replacement.
 * Remove after release 0.6.17.
 */

import { internalAction } from './_generated/server';
import {
	attemptSystemEmail,
	sendSystemEmailOrThrow,
	systemMailArgs,
} from './maintenance/systemMail';

/** Remove after release 0.6.17; this release calls `maintenance/systemMail:trySendSystemEmail`. */
export const trySendSystemEmail = internalAction({
	args: systemMailArgs,
	handler: attemptSystemEmail,
});

/** Remove after release 0.6.17; this release calls `maintenance/systemMail:sendSystemEmail`. */
export const sendSystemEmail = internalAction({
	args: systemMailArgs,
	handler: sendSystemEmailOrThrow,
});
