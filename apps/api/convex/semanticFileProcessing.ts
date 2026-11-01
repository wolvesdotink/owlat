'use node';

/**
 * Previous-release paths of `files/processing.ts`. A processing run the
 * previous release queued (an upload, an attachment capture, the backfill, a
 * budget deferral, a batch continuation) runs
 * `semanticFileProcessing:processFile` by path, with the arguments that
 * release recorded, and a previous-release action still running when this one
 * deploys (agent context retrieval, an attachment suggestion, the assistant)
 * searches files through `semanticFileProcessing:semanticSearch`. Each keeps
 * its old path, builder, arguments and result shape, and runs the same body as
 * its replacement. Remove after release 0.6.17.
 */

import { internalAction } from './_generated/server';
import { anchorActionDeadline } from './lib/llm/actionDeadline';
import {
	processFileArgs,
	processSemanticFile,
	searchSemanticFiles,
	semanticSearchArgs,
} from './files/processing';

/** Remove after release 0.6.17; this release schedules `files/processing:processFile`. */
export const processFile = internalAction({
	args: processFileArgs,
	handler: async (ctx, args) => {
		// One model budget for this action, from its start.
		anchorActionDeadline(ctx);
		await processSemanticFile(ctx, args);
	},
});

/** Remove after release 0.6.17; this release calls `files/processing:semanticSearch`. */
export const semanticSearch = internalAction({
	args: semanticSearchArgs,
	handler: async (ctx, args) => {
		// One model budget for this action, from its start.
		anchorActionDeadline(ctx);
		return await searchSemanticFiles(ctx, args);
	},
});
