/**
 * Per-domain VERP return-path host — public write surface (D1/D2).
 *
 * Split out of `domains/domains.ts` (CONVENTIONS.md: split a feature file once it
 * grows past ~500 LOC). This is the thin, admin-gated public shell over the
 * **Sending domain lifecycle (module)**'s `setReturnPathHost` — validation +
 * authz only; the record regeneration, status drop, MTA reflection, and audit
 * all live in `domains/lifecycle.ts`.
 */

import { v } from 'convex/values';
import { internal } from '../_generated/api';
import { throwInvalidInput, throwNotFound, throwInvalidState } from '../_utils/errors';
import { authedMutation } from '../lib/authedFunctions';
import { requireOrgPermission } from '../lib/sessionOrganization';
import { asDnsName } from '@owlat/shared';

// Synthetic userId tag for user-driven public-mutation transitions (mirrors
// `domains/domains.ts`) — user-driven calls carry no `system:` prefix, which the
// lifecycle reducer keys on.
const LIFECYCLE_USER_PUBLIC_MUTATION = 'user';

// Mutation: Set (or change) the domain's per-domain VERP return-path host
// (D1/D2). Delegates to the lifecycle's `setReturnPathHost`, which regenerates
// the `mailFrom` SPF record on the new host, drops the domain to `pending` for
// re-verification, and reflects the host to the MTA. Admin-gated
// (`organization:manage`) to match the other domain-management writes.
export const setReturnPathHost = authedMutation({
	args: {
		domainId: v.id('domains'),
		returnPathHost: v.string(),
	},
	handler: async (ctx, args) => {
		await requireOrgPermission(
			ctx,
			'organization:manage',
			'Only owners and admins can manage sending domains'
		);
		// Validate + normalize the host up front with the shared DNS-name
		// primitive so a bad value is a clean 400 (`invalid_input`) rather than a
		// lifecycle miss. The lifecycle re-validates (defense in depth).
		const normalized = asDnsName(args.returnPathHost);
		if (normalized === null) {
			throwInvalidInput(
				'Invalid return-path host. Enter a valid DNS hostname, e.g. bounce.example.com.'
			);
		}
		const outcome = await ctx.runMutation(internal.domains.lifecycle.setReturnPathHost, {
			domainId: args.domainId,
			returnPathHost: normalized,
			userId: LIFECYCLE_USER_PUBLIC_MUTATION,
		});
		if (!outcome.ok) {
			if (outcome.reason === 'domain_not_found') throwNotFound('Domain');
			if (outcome.reason === 'invalid_host') {
				throwInvalidInput('Invalid return-path host.');
			}
			if (outcome.reason === 'unsupported_provider') {
				throwInvalidState('This domain is not managed by the built-in MTA provider.');
			}
			// Catch-all for any unexpected reason (keeps the human sentences above).
			throwInvalidState(`Cannot set return-path host: ${outcome.reason}`);
		}
	},
});
