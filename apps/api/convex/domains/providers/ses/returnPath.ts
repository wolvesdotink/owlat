/**
 * SES's custom return-path support: SES's custom MAIL FROM, which must be a
 * subdomain of the sending domain and publishes SES's MX + SPF TXT pair
 * (`./mailFrom.ts`). SES learns the host through `SetIdentityMailFromDomain`.
 */

import { internal } from '../../../_generated/api';
import { getRequired } from '../../../lib/env';
import type { SendingDomainReturnPath } from '../returnPathTypes';
import { buildSesMailFromRecords, resolveSesMailFrom } from './mailFrom';

export const sesReturnPath: SendingDomainReturnPath = {
	fitsHost: (domainName, host) => resolveSesMailFrom(domainName, host) !== null,

	mailFromRecords(domainName, host) {
		const sesMailFrom = resolveSesMailFrom(domainName, host);
		// Not a subdomain: the edit path already refused it through `fitsHost`.
		if (!sesMailFrom) return undefined;
		// `getRequired` (matching the SES registration path) so the region can never
		// be blank — a `?? ''` fallback would write a malformed MX.
		return buildSesMailFromRecords(sesMailFrom.host, getRequired('AWS_SES_REGION'));
	},

	async scheduleReflection(ctx, domainId, host) {
		await ctx.scheduler.runAfter(0, internal.domains.providers.registerAction.reflectSesMailFrom, {
			domainId,
			returnPathHost: host,
			attempt: 0,
		});
	},

	// With no host configured SES uses the default `mail.<domain>`.
	activeHost: (domainName, configuredHost) =>
		resolveSesMailFrom(domainName, configuredHost)?.mailFromDomain ?? null,
};
