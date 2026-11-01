'use node';

/**
 * Previous-release path of `emailTemplates/translate.ts`. A template
 * translation editor or Postbox reader in a tab opened before the deploy still
 * calls `translate:translateBatch` by path. It keeps its old path, builder,
 * auth floor, arguments and result shape, and runs the same body as its
 * replacement. Remove after release 0.6.17.
 */

import { anchorActionDeadline } from './lib/llm/actionDeadline';
import { authedAction } from './lib/authedFunctions';
import {
	translateBatchArgs,
	translateItems,
	type TranslatedItem,
} from './emailTemplates/translate';

/** Remove after release 0.6.17; this release calls `emailTemplates/translate:translateBatch`. */
// all-members: content translation utility available to any authenticated member.
export const translateBatch = authedAction({
	args: translateBatchArgs,
	handler: async (ctx, args): Promise<{ translations: TranslatedItem[] }> => {
		// One model budget for this action, from its start.
		anchorActionDeadline(ctx);
		return await translateItems(ctx, args);
	},
});
