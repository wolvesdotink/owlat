/**
 * Our own MTA's custom return-path support. The MTA takes any host
 * `normalizeReturnPathHost` accepted, publishes a bounce MX plus a pool-IP SPF
 * TXT on it, and learns the host through its idempotent register endpoint.
 */

import { internal } from '../../../_generated/api';
import { getOptional } from '../../../lib/env';
import { logWarn } from '../../../lib/runtimeLog';
import {
	buildReturnPathMailFromRecords,
	parsePoolIps,
	parseReturnPathRelaySpfTerms,
	resolveSpfQualifier,
} from '../../spf';
import type { SendingDomainReturnPath } from '../returnPathTypes';

export const mtaReturnPath: SendingDomainReturnPath = {
	fitsHost: () => true,

	mailFromRecords(domainName, host) {
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
	},

	// The register endpoint is idempotent for the DKIM key, so the push changes
	// only the host.
	async scheduleReflection(ctx, domainId, host) {
		await ctx.scheduler.runAfter(0, internal.domains.providers.registerAction.pushReturnPathHost, {
			domainId,
			returnPathHost: host,
			attempt: 0,
		});
	},

	// A domain with no host of its own bounces through the deployment-global
	// `MTA_RETURN_PATH_DOMAIN`, the same fallback registration publishes.
	activeHost: (_domainName, configuredHost) =>
		configuredHost ??
		getOptional('MTA_RETURN_PATH_DOMAIN')?.trim().toLowerCase().replace(/\.$/, '') ??
		null,
};
