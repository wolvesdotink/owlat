/**
 * Actions on a send that is already scheduled, for surfaces outside the
 * composer (Today's Upcoming band). Unscheduling stays `drafts.cancelScheduledSend`;
 * this module adds sending it now. The handler lives with the other send-side
 * handlers in `./draftSend.ts`, and every state write goes through the Mail
 * draft lifecycle module.
 */

import { v } from 'convex/values';
import { postboxMutation } from './_helpers';
import { sendScheduledNowHandler } from './draftSend';

/**
 * Send a scheduled draft now, with the sender's undo window. `{ ok: false }`
 * when the draft is no longer scheduled (sent, cancelled, already sending).
 */
// authz: draftSend.sendScheduledNowHandler enforces mailbox access.
export const sendNow = postboxMutation({
	args: {
		draftId: v.id('mailDrafts'),
		undoSendDelayMs: v.optional(v.number()),
	},
	handler: sendScheduledNowHandler,
});
