'use node';

/**
 * One verification pass after the DNS lookups: ask the domain's provider for
 * its own verdict, mirror it into the results, and land both through
 * `lifecycle.recordVerification`. Shared by the manual Verify
 * (`dnsVerification.verifyDomain`) and the scheduled re-check
 * (`reverification.reverifyDomain`), so a domain's status changes the same way
 * whoever asked.
 */

import type { Infer } from 'convex/values';
import { internal } from '../_generated/api';
import type { Doc } from '../_generated/dataModel';
import type { ActionCtx } from '../_generated/server';
import type { verificationResultsValidator } from '../lib/convexValidators';
import { logError } from '../lib/runtimeLog';
import type { VerificationOutcome } from './lifecycle';
import { isSendingDomainProviderKind, providerFor } from './providers';
import type { ProviderCheckResult } from './providers';

const LIFECYCLE_USER_VERIFIER = 'system:verifier';

export async function recordVerificationPass(
	ctx: ActionCtx,
	domain: Doc<'domains'>,
	results: Infer<typeof verificationResultsValidator>
): Promise<VerificationOutcome> {
	// Per-provider check. SES implements `runProviderCheck`; MTA omits it
	// (treated as `{ verified: true }`).
	let providerCheck: ProviderCheckResult = { verified: true };
	if (isSendingDomainProviderKind(domain.providerType)) {
		const adapter = providerFor(domain.providerType);
		if (adapter.runProviderCheck) {
			try {
				providerCheck = await adapter.runProviderCheck(domain.domain);
				// Mirror the provider verdict into the persisted
				// `verificationResults` bundle. WHICH field carries it — and whether
				// this provider has a verdict worth recording at all — is the
				// adapter's own business, so no `providerType === 'ses'` check or SES
				// field name is spelled here.
				Object.assign(results, adapter.verificationStatusFields?.(providerCheck));
			} catch (error) {
				logError('[DNS Verification] Failed to run provider check:', error);
				providerCheck = {
					verified: false,
					lastError: error instanceof Error ? error.message : 'Unknown provider error',
				};
			}
		}
	}

	return await ctx.runMutation(internal.domains.lifecycle.recordVerification, {
		domainId: domain._id,
		verificationResults: results,
		providerCheck,
		userId: LIFECYCLE_USER_VERIFIER,
	});
}
