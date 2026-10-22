/** The placeholders the mail-sync fixtures name minted values by. */

import { wirePlaceholder as id } from './types';

export const MAIL_SYNC_WIRE_IDS = {
	mailbox: id('mailboxes/sync'),
	oauthMailbox: id('mailboxes/oauth'),
	account: id('externalMailAccounts/password'),
	oauthAccount: id('externalMailAccounts/oauth'),
	seedAccount: id('externalMailAccounts/seed'),
	inbox: id('mailFolders/inbox'),
	archive: id('mailFolders/archive'),
	migration: id('mailboxMigrations/importing'),
	ingested: id('mailMessages/ingested'),
	moveOp: id('externalMailRemoteOps/move'),
	flagsOp: id('externalMailRemoteOps/flags'),
	renameOp: id('externalMailRemoteOps/rename'),
	localCursor: id('cursor/local'),
	localPartialCursor: id('cursor/local-partial'),
	renamesCursor: id('cursor/renames'),
} as const;
