import { api } from '@owlat/api';
import type { Id } from '@owlat/api/dataModel';
import { createRawEmlLoader } from '~/composables/rawEmlLoader';

/**
 * Fetch a TEAM-INBOX message's raw `.eml`, decoded binary-safely.
 *
 * One line of its own rather than a call into `postbox/loadRawEml`: that one
 * mints through the mailbox action and casts to `Id<'mailMessages'>`, so
 * calling it with an inbound id typechecks and then returns null at runtime.
 * The fetch, the latin1 decode and the bounded cache are `createRawEmlLoader`,
 * shared with Postbox.
 */
export const loadInboundRawEml = createRawEmlLoader((messageId) =>
	requireConvex().action(api.inbox.rawMessage.getInboundMessageRawUrl, {
		messageId: messageId as Id<'inboundMessages'>,
	})
);
