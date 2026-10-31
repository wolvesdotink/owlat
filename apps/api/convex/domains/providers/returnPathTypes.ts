/** The sending-domain provider module's custom return-path capability. */

import type { Id } from '../../_generated/dataModel';
import type { MutationCtx } from '../../_generated/server';
import type { DnsRecords } from '../domains';

/**
 * A kind's support for a per-domain custom return-path (VERP MAIL FROM) host.
 * The lifecycle's create check, `setReturnPathHost`, the post-registration
 * reconcile and the deliverability checklist all ask this instead of the kind.
 *
 * NOT the send-transport catalog's `supportsCustomReturnPath`. That field says
 * whether a TRANSPORT lets us stamp our own per-message envelope sender (SES
 * declares `no`: it rewrites the envelope itself); this says whether a sending
 * DOMAIN at this provider can carry a custom MAIL FROM host (SES can, as a
 * subdomain). The two disagree for shipped kinds, so neither is derived from
 * the other.
 */
export interface SendingDomainReturnPath {
	/**
	 * Whether an already-normalized host (`normalizeReturnPathHost`) can serve as
	 * this kind's return path for `domainName`. Checked on create and on every
	 * edit, so a host the provider would reject is never stored.
	 */
	fitsHost(domainName: string, host: string): boolean;

	/**
	 * The `mailFrom` records a custom host publishes. The edit and the
	 * post-registration reconcile both call this, so a given host yields the same
	 * records on both paths. `undefined` means there is nothing to publish, and
	 * the caller drops any stale `mailFrom` entry.
	 */
	mailFromRecords(domainName: string, host: string): DnsRecords['mailFrom'];

	/**
	 * Schedule the action that tells the provider about the host so its bounce
	 * envelope uses it. Scheduled, not inline: the DB write before it must not
	 * roll back on a provider hiccup, and mutations cannot run the node-runtime
	 * API clients. The action owns its retry budget and records a give-up through
	 * `recordReturnPathPushResult`, so a permanent failure is never silent.
	 */
	scheduleReflection(ctx: MutationCtx, domainId: Id<'domains'>, host: string): Promise<void>;

	/**
	 * The host this kind's bounce envelope uses for `domainName` right now, given
	 * the domain's configured host (lower-cased, no trailing dot; `undefined`
	 * when none is set). `null` when no return path is active. The checklist
	 * requires every published `mailFrom` record to sit on this host.
	 */
	activeHost(domainName: string, configuredHost: string | undefined): string | null;
}
