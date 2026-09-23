/**
 * The MTA-identity step of the setup wizard.
 *
 * Module scope, so the validator never calls `useI18n`: it returns a catalog KEY
 * for the failure (or `undefined` when the draft is fine), and the wizard
 * resolves it with `t()` where the message is shown.
 *
 * Per-IP EHLO overrides (`EHLO_HOSTNAMES`) are not asked here: they are set on
 * Settings → Delivery provider (components/delivery/EhloOverridesCard). A value
 * already in the .env passes through setup untouched.
 */
export interface MtaIdentityDraft {
	transactionalIps: string;
	campaignIps: string;
	ehloHostname: string;
}

export function validateMtaIdentityDraft(
	identity: MtaIdentityDraft | undefined
): string | undefined {
	if (
		!identity?.transactionalIps.trim() ||
		!identity.campaignIps.trim() ||
		!identity.ehloHostname.trim()
	) {
		return 'shared.setupMtaIdentity.missingIpsOrHostname';
	}
}

export function buildMtaIdentityEnv(identity: MtaIdentityDraft): Record<string, string> {
	return {
		IP_POOLS_TRANSACTIONAL: identity.transactionalIps.trim(),
		IP_POOLS_CAMPAIGN: identity.campaignIps.trim(),
		EHLO_HOSTNAME: identity.ehloHostname.trim(),
	};
}
