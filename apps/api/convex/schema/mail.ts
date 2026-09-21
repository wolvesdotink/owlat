import { mailboxesTables } from './mailboxes';
import { mailAccountsTables } from './mailAccounts';
import { mailMessagesTables } from './mailMessages';
import { mailThreadsTables } from './mailThreads';
import { mailCompositionTables } from './mailComposition';
import { mailRulesTables } from './mailRules';
import { mailAuthTables } from './mailAuth';
import { mailContactsTables } from './mailContacts';
import { mailSettingsTables } from './mailSettings';
import { mailAiTables } from './mailAi';

/**
 * Personal Mail (Postbox) tables — Gmail-equivalent backend.
 *
 * Distinct from `inboundMessages`/`conversationThreads` which power the
 * AI-assisted shared support inbox (defined in schema.ts).
 *
 * The table definitions live in feature siblings (schema/mail*.ts); this module
 * only composes them. Spread into `defineSchema()` from schema.ts via
 * `...mailTables`.
 */
export const mailTables = {
	...mailboxesTables,
	...mailAccountsTables,
	...mailMessagesTables,
	...mailThreadsTables,
	...mailCompositionTables,
	...mailRulesTables,
	...mailAuthTables,
	...mailContactsTables,
	...mailSettingsTables,
	...mailAiTables,
};
