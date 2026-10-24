/**
 * The wire-version report (`maintenance/workerRegistry`): this worker's release
 * and wire version, at startup and every five minutes, answered with the
 * backend's side of the mail-sync contract.
 */

import { WORKER_SERVICES } from '@owlat/shared/workerWire';
import { v } from 'convex/values';
import { defineEndpoint } from '../contract';
import { literalUnion } from '../literalUnion';

/** Every service that reports; the function serves them all with the admin key. */
const workerServiceValidator = literalUnion(WORKER_SERVICES);

const workerReportAnswerFields = {
	backendWireVersion: v.number(),
	minSupportedWireVersion: v.number(),
	compatible: v.boolean(),
};

/**
 * The worker reads `reason` as a hint only: a refusal it has no name for is a
 * later backend's reason, so it accepts any string there while the backend
 * produces exactly the two it knows.
 */
export const reportWorker = defineEndpoint({
	path: 'maintenance/workerRegistry:report',
	kind: 'mutation',
	args: {
		service: workerServiceValidator,
		instanceId: v.string(),
		hostLabel: v.string(),
		owlatVersion: v.string(),
		wireVersion: v.number(),
		startedAt: v.number(),
	},
	returns: v.object({
		...workerReportAnswerFields,
		reason: v.optional(v.union(v.literal('server_too_old'), v.literal('backend_older'))),
	}),
	accepts: v.object({ ...workerReportAnswerFields, reason: v.optional(v.string()) }),
});
