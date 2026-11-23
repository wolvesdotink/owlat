/**
 * What `GET /api/v1/domains` answers (`./domainsHttp.ts`): every sending domain
 * with the records it needs and what the last check found
 * (`domains/recordStates.ts`).
 */

import type { SendingDomainSetup } from '@owlat/public-contract';
import { internalQuery } from '../_generated/server';
import { loadSendingDomainSetups } from '../domains/recordStates';

export const listForApi = internalQuery({
	args: {},
	handler: async (ctx): Promise<SendingDomainSetup[]> => loadSendingDomainSetups(ctx.db),
});
