import { api } from '@owlat/api';
import type { Id } from '@owlat/api/dataModel';
import { createRawEmlLoader } from '~/composables/rawEmlLoader';

/**
 * Fetch a POSTBOX message's raw `.eml`, decoded binary-safely. Shared by the
 * reader (attachment download), the composer (Forward clone), and the invite
 * card (ICS).
 *
 * The fetch, the latin1 decode and the bounded per-message cache are
 * `createRawEmlLoader`, shared with the team-inbox loader; only the minting
 * action differs.
 */
export const loadRawEml = createRawEmlLoader((messageId) =>
	requireConvex().action(api.mail.mailbox.messages.getMessageRawUrl, {
		messageId: messageId as Id<'mailMessages'>,
	})
);
