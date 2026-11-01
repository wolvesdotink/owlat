/**
 * Previous-release path of `assistant/quickQueryGate.ts`. A previous release's
 * Quick Query action still running when this one deploys asserts knowledge
 * access through `quickQueryGate:assertKnowledgeReadAccess` by path. It keeps
 * its old path, builder, arguments and result shape, and runs the same body as
 * its replacement. Remove after release 0.6.17.
 */

import { internalQuery } from './_generated/server';
import { assertKnowledgeRead } from './assistant/quickQueryGate';

/** Remove after release 0.6.17; this release calls `assistant/quickQueryGate:assertKnowledgeReadAccess`. */
export const assertKnowledgeReadAccess = internalQuery({
	args: {},
	handler: async (ctx): Promise<{ canReadInbox: boolean }> => await assertKnowledgeRead(ctx),
});
