/**
 * Inbound deliveries during a workspace deletion: ACCEPT AND DROP.
 *
 * While the workspace is being deleted the write fence refuses what an inbound
 * delivery would store (lib/writeFence.ts). Answering that with a 5xx is the
 * wrong signal: the MTA retries a non-2xx a few times and then parks the event
 * in its Redis dead-letter queue, outside the deletion's reach, from where a
 * later replay would deliver a deleted tenant's mail into the emptied
 * workspace. Provider and plugin feedback likewise redelivers into it. The
 * workspace these deliveries belong to is going away, so the routes answer with
 * a final 2xx that says the delivery was ignored, and log that they did.
 */

import type { ActionCtx } from '../_generated/server';
import { internal } from '../_generated/api';
import { logWarn } from '../lib/runtimeLog';
import { WORKSPACE_DELETION_REFUSAL, isWorkspaceDeletionRefusal } from '../lib/writeFence';
import { jsonResponse } from './inboundHttp';

export { isWorkspaceDeletionRefusal };

/**
 * Whether a workspace deletion is running. Checked up front by the inbound
 * mail routes, so a delivery the fence would refuse does not first store its
 * raw bytes in file storage, where nothing would ever reference them.
 */
export async function isWorkspaceBeingDeleted(ctx: ActionCtx): Promise<boolean> {
	const job = await ctx.runQuery(internal.workspaces.deletion.walker.status, {});
	return job?.isActive === true;
}

/** The final acknowledgement for a delivery dropped because of the deletion. */
export function workspaceDeletionAck(logTag: string): Response {
	logWarn(`${logTag} workspace deletion in progress; delivery acknowledged and dropped`);
	return jsonResponse(200, { success: true, ignored: WORKSPACE_DELETION_REFUSAL });
}
