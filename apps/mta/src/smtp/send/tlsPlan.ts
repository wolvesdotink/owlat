/**
 * TLS phase: resolve the transport-security floor for one destination.
 *
 * Combines the operator's outbound TLS mode (per-domain override, else the
 * global setting), the destination provider's own floor and the recipient's
 * MTA-STS state through the strictest-wins resolver, and derives the TLS-RPT
 * attribution that every recorded result carries. `opportunistic` with no
 * policy yields requireTLS:false / verify:false; `require` / `require-verified`
 * raise the handshake demand. DANE precedence lives in the same resolver, so
 * the DANE-authenticated floor is derived here too rather than re-encoded by
 * hand inside the MX loop.
 */

import type Redis from 'ioredis';
import type { OutboundTlsMode } from '@owlat/shared';
import type { MtaConfig } from '../../config.js';
import { logger } from '../../monitoring/logger.js';
import { getStsTlsOptions, type StsPolicyMode } from '../mtaSts.js';
import { resolveOutboundTlsMode } from '../outboundTlsOverrides.js';
import { resolveTlsRequirements, type TlsRequirements } from '../tlsPolicy.js';
import { buildStsPolicyString, type TlsPolicyContext } from '../tlsRpt.js';

/** The TLS decisions the MX loop applies, resolved once per job. */
export interface SendTlsPlan {
	stsPolicyMode: StsPolicyMode;
	/** MX patterns the MTA-STS policy permits (empty without a policy). */
	allowedMxHosts: string[];
	localTlsMode: OutboundTlsMode;
	/** Floor for a normal attempt (no usable TLSA RRset). */
	requirements: TlsRequirements;
	/** Floor for an attempt authenticated by a usable TLSA RRset (RFC 7672 §2). */
	daneRequirements: TlsRequirements;
	/** TLS-RPT attribution for every non-DANE result recorded on this job. */
	policyContext: TlsPolicyContext;
}

export async function resolveSendTlsPlan(
	redis: Redis,
	config: MtaConfig,
	recipientDomain: string,
	providerMode: OutboundTlsMode
): Promise<SendTlsPlan> {
	// Fetch the MTA-STS policy for the recipient domain (never blocks delivery on
	// failure).
	const stsOptions = await getStsTlsOptions(redis, recipientDomain);
	if (stsOptions.policyMode === 'enforce') {
		logger.debug({ recipientDomain, mx: stsOptions.allowedMxHosts }, 'MTA-STS enforce mode active');
	}

	const localTlsMode = await resolveOutboundTlsMode(
		redis,
		recipientDomain,
		config.outboundTlsMode ?? 'opportunistic'
	);
	const stsPolicy = { policyMode: stsOptions.policyMode };
	const requirements = resolveTlsRequirements({
		localMode: localTlsMode,
		providerMode,
		stsPolicy,
		daneResult: null,
	});
	if (localTlsMode !== 'opportunistic') {
		logger.debug(
			{ recipientDomain, localTlsMode, reason: requirements.reason },
			'Outbound TLS floor raised'
		);
	}

	// TLS-RPT policy context: when an MTA-STS policy applies, every recorded TLS
	// result is attributed to policy-type 'sts' with the policy body + MX
	// patterns (RFC 8460 §3). Without a policy, results stay 'no-policy-found'.
	const policyContext: TlsPolicyContext =
		stsOptions.policyMode === 'enforce' || stsOptions.policyMode === 'testing'
			? {
					policyType: 'sts',
					policyString: buildStsPolicyString(stsOptions.policyMode, stsOptions.allowedMxHosts),
					mxHostPatterns: stsOptions.allowedMxHosts,
				}
			: { policyType: 'no-policy-found', policyString: [] };

	return {
		stsPolicyMode: stsOptions.policyMode,
		allowedMxHosts: stsOptions.allowedMxHosts,
		localTlsMode,
		requirements,
		// A usable TLSA RRset supersedes MTA-STS: requireTLS + verified TLS.
		daneRequirements: resolveTlsRequirements({
			localMode: localTlsMode,
			providerMode,
			stsPolicy,
			daneResult: { usable: true },
		}),
		policyContext,
	};
}
