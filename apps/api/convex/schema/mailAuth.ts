import { defineTable } from 'convex/server';
import { v } from 'convex/values';
import { mailAppPasswordScopeValidator } from '../lib/convexValidators';

/**
 * Mailbox credentials and the audit trail: IMAP/SMTP app passwords,
 * failed-auth records and the per-mailbox audit log.
 *
 * Spread into `mailTables` from schema/mail.ts.
 */
export const mailAuthTables = {
	mailAppPasswords: defineTable({
		mailboxId: v.id('mailboxes'),
		userId: v.string(),
		label: v.string(), // e.g. "iPhone Mail", "Thunderbird"
		passwordHash: v.string(), // PBKDF2-SHA256 derived; encoded as <salt-hex>:<hash-hex>
		passwordPrefix: v.string(), // first 4 chars, lowercase
		scopes: v.array(mailAppPasswordScopeValidator),
		createdAt: v.number(),
		lastUsedAt: v.optional(v.number()),
		lastUsedIp: v.optional(v.string()),
		lastUsedUa: v.optional(v.string()),
		revokedAt: v.optional(v.number()),
	})
		.index('by_mailbox', ['mailboxId'])
		.index('by_user', ['userId'])
		.index('by_prefix', ['passwordPrefix']),

	// Sliding-window auth-failure log. Backs the SMTP submission rate limit
	// (the IMAP path uses Redis for lower latency). A cron sweeps entries
	// older than 24h. Index by lowercase address + occurredAt so the
	// throttle check is a single range scan.

	mailAuthFailures: defineTable({
		address: v.string(), // lowercase canonical
		ip: v.optional(v.string()),
		// Which credential prompt the failure came from. `recovery-kit` is the
		// Sealed-Mail password re-prompt (plan idea 55); it shares the table but
		// NOT the budget. Both readers count only the scopes they own —
		// `e2ee/memberKeys.ts` counts `recovery-kit`, `mail/authRateLimit.ts`
		// counts `imap`/`smtp` — so a fumbled settings prompt can never lock a
		// mail client out of submission, nor a mail client the settings prompt.
		// A new scope MUST be filtered in by its own reader, never inherited.
		scope: v.union(v.literal('imap'), v.literal('smtp'), v.literal('recovery-kit')),
		occurredAt: v.number(),
	})
		.index('by_address_and_time', ['address', 'occurredAt'])
		.index('by_ip_and_time', ['ip', 'occurredAt'])
		.index('by_time', ['occurredAt']),

	// Sieve-style filters that run on inbound mail before final folder
	// placement. Conditions are AND'd; multiple filters can match (priority
	// ascending) unless a matching filter sets stopProcessing=true.

	mailAuditLog: defineTable({
		mailboxId: v.id('mailboxes'),
		event: v.string(),
		details: v.optional(v.string()),
		ip: v.optional(v.string()),
		userAgent: v.optional(v.string()),
		occurredAt: v.number(),
	}).index('by_mailbox_and_time', ['mailboxId', 'occurredAt']),

	// App passwords for native IMAP/SMTP clients (Apple Mail, Thunderbird, …)
	// The cleartext password is shown ONCE at creation and never recoverable.
	// The first 4 chars are stored separately so the resolver can narrow to a
	// small candidate set before running the (intentionally slow) hash compare.
};
