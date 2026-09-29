/**
 * The per-domain return path's provider branches, in one place.
 *
 * A custom VERP return-path host is honoured by our own MTA and by SES; every
 * other provider manages its own bounce path. Which kinds accept a host, which
 * hosts fit a kind, which `mailFrom` bundle a host publishes and which action
 * reflects it to the provider all branch on the kind. The capability has no
 * home on the sending-domain adapter interface yet (`providers/index.ts` states
 * the gap), so until it does, every such branch lives here and nowhere else:
 * `lifecycle.create` validates through it, and `lifecycleReturnPath.ts` edits,
 * reconciles and reflects through it. See scripts/provider-identity-allowlist.txt.
 */

import type { MutationCtx } from '../_generated/server';
import { internal } from '../_generated/api';
import type { Id } from '../_generated/dataModel';
import { getOptional, getRequired } from '../lib/env';
import { logWarn } from '../lib/runtimeLog';
import type { DnsRecords } from './lifecycleReducer';
import type { SendingDomainProviderKind } from './providers';
import { buildSesMailFromRecords, resolveSesMailFrom } from './providers/ses/mailFrom';
import {
	buildReturnPathMailFromRecords,
	parsePoolIps,
	parseReturnPathRelaySpfTerms,
	resolveSpfQualifier,
} from './spf';

export type ReturnPathProviderKind = Extract<SendingDomainProviderKind, 'mta' | 'ses'>;

/** The kind, when it accepts a custom return-path host; `null` otherwise. */
export function returnPathProviderKind(
	providerType: string | undefined
): ReturnPathProviderKind | null {
	return providerType === 'mta' || providerType === 'ses' ? providerType : null;
}

/**
 * Whether an already-normalized host can serve as this kind's return path. SES
 * requires its custom MAIL FROM to be a subdomain of the sending domain; the
 * MTA takes any host `normalizeReturnPathHost` accepted.
 */
export function returnPathHostFits(
	kind: ReturnPathProviderKind,
	domainName: string,
	host: string
): boolean {
	return kind !== 'ses' || resolveSesMailFrom(domainName, host) !== null;
}

/**
 * Build the provider-specific `mailFrom` record bundle for a custom return-path
 * host. MTA: the bounce-routing MX (EHLO_HOSTNAME) + a pool-IP SPF TXT. SES: the
 * MX + SPF TXT SES requires at the MAIL FROM subdomain. Shared by
 * `setReturnPathHost` and the post-registration reconcile so both emit
 * byte-identical records for a given host (no drift). Returns `undefined` when
 * there is nothing to publish (MTA with no pool IPs) or the SES host is not a
 * subdomain of the sending domain (already rejected upstream on the edit path).
 */
export function buildReturnPathMailFrom(
	kind: ReturnPathProviderKind,
	domainName: string,
	host: string
): DnsRecords['mailFrom'] {
	if (kind === 'mta') {
		const qualifier = resolveSpfQualifier(getOptional('SPF_QUALIFIER'));
		const poolIps = parsePoolIps(getOptional('MTA_IP_POOLS'));
		const mailHost = getOptional('EHLO_HOSTNAME')?.trim();
		if (!mailHost) {
			// A custom host with no mail host publishes an SPF-only bundle with no
			// bounce MX — warn (mirrors the registration path); DSNs can't route back.
			logWarn(
				`[MTA] return-path host ${host} set for ${domainName} but EHLO_HOSTNAME is empty — no bounce MX emitted; remote MTAs cannot deliver DSNs to bounce+…@${host}.`
			);
		}
		// The SAME bundle the registration path emits — including the relay
		// authorisation terms. A return-path EDIT that dropped them would
		// republish a record the relay is no longer covered by, silently
		// withdrawing the VERP stamp on the next verification.
		return buildReturnPathMailFromRecords(
			host,
			poolIps,
			qualifier,
			mailHost,
			parseReturnPathRelaySpfTerms(getOptional('MTA_RETURN_PATH_RELAY_SPF'))
		);
	}
	const sesMailFrom = resolveSesMailFrom(domainName, host);
	if (!sesMailFrom) return undefined;
	// `getRequired` (matching the SES registration path) so the region can never be
	// blank — a `?? ''` fallback would write a malformed MX.
	return buildSesMailFromRecords(sesMailFrom.host, getRequired('AWS_SES_REGION'));
}

/**
 * Schedule the action that reflects the host to the provider so its bounce
 * envelope uses it: `pushReturnPathHost` for the MTA (its register endpoint is
 * idempotent for the DKIM key, so only the host changes), `reflectSesMailFrom`
 * (SES `SetIdentityMailFromDomain`) for SES.
 *
 * Scheduled, not inline: the DB write before it must not roll back on a
 * provider hiccup, and mutations cannot run the node-runtime API clients. Both
 * actions run a bounded, self-rescheduling retry; when the budget runs out they
 * record the failure via `recordReturnPathPushResult` (audit + the
 * `returnPathHostSyncError` marker), so a permanent failure is never silent.
 */
export async function scheduleReturnPathReflection(
	ctx: MutationCtx,
	kind: ReturnPathProviderKind,
	domainId: Id<'domains'>,
	returnPathHost: string
): Promise<void> {
	const args = { domainId, returnPathHost, attempt: 0 };
	if (kind === 'mta') {
		await ctx.scheduler.runAfter(
			0,
			internal.domains.providers.registerAction.pushReturnPathHost,
			args
		);
	} else {
		await ctx.scheduler.runAfter(
			0,
			internal.domains.providers.registerAction.reflectSesMailFrom,
			args
		);
	}
}
