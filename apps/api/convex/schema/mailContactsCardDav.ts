import { defineTable } from 'convex/server';
import { v } from 'convex/values';
import {
	mailCardDavErrorCodeValidator,
	mailCardDavSyncStatusValidator,
} from '../lib/validators/mailContacts';

/**
 * Read-only CardDAV address books synced into a mailbox's address book
 * (`mailContacts`). One account per mailbox: a team inbox's book is shared by
 * its members, a personal mailbox's is the member's own.
 *
 * Cascade: the rows a sync inserted point back here through
 * `mailContacts.cardDavSource.accountId`. Disconnecting deletes this row and
 * then those rows (mail/contactsCardDav.ts); rows the sync only merged into
 * keep their data and lose the link.
 *
 * Spread into `mailTables` from schema/mail.ts.
 */
export const mailContactsCardDavTables = {
	mailCardDavAccounts: defineTable({
		mailboxId: v.id('mailboxes'),
		/** The server URL as the user typed it, normalized to https. */
		serverUrl: v.string(),
		/** The address book discovery found, absolute. Every request stays on its origin. */
		addressBookUrl: v.string(),
		addressBookName: v.optional(v.string()),
		username: v.string(),
		// The password, sealed with the CardDAV box of lib/credentialCrypto.ts
		// (AES-256-GCM under INSTANCE_SECRET). Never returned by a public function.
		secretCiphertext: v.string(),
		secretIv: v.string(),
		secretAuthTag: v.string(),
		secretEnvelopeVersion: v.number(),
		/** The sync report's token after the last complete sync (RFC 6578). */
		syncToken: v.optional(v.string()),
		/** The book's change tag, for servers without the sync report. */
		ctag: v.optional(v.string()),
		status: mailCardDavSyncStatusValidator,
		lastSyncedAt: v.optional(v.number()),
		/** Why the last sync failed; the contacts page words it. */
		lastErrorCode: v.optional(mailCardDavErrorCodeValidator),
		/** The book held more cards than one sync reads; the rest were skipped. */
		isTruncated: v.optional(v.boolean()),
		/** When the recurring sync (crons.ts) next picks this account up. */
		nextSyncAt: v.number(),
		/** The last "Sync now", which is refused again within a minute. */
		syncRequestedAt: v.optional(v.number()),
		/**
		 * The sync that holds the account (`_claimSync`) and when its claim lapses.
		 * Only the holder's writes land, so overlapping syncs cannot interleave.
		 */
		syncRunToken: v.optional(v.string()),
		syncRunExpiresAt: v.optional(v.number()),
		createdAt: v.number(),
		updatedAt: v.number(),
	})
		.index('by_mailbox', ['mailboxId'])
		.index('by_next_sync', ['nextSyncAt']),
};
