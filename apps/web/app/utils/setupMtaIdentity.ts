/**
 * The MTA-identity step of the setup wizard.
 *
 * Module scope, so the validator never calls `useI18n`: it returns a catalog KEY
 * for the failure (or `undefined` when the draft is fine), and the wizard
 * resolves it with `t()` where the message is shown.
 */
export interface MtaIdentityDraft {
	transactionalIps: string;
	campaignIps: string;
	ehloHostname: string;
	ehloHostnames: string;
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
	if (!identity.ehloHostnames.trim()) return;
	try {
		const parsed: unknown = JSON.parse(identity.ehloHostnames);
		if (
			typeof parsed !== 'object' ||
			parsed === null ||
			Array.isArray(parsed) ||
			Object.values(parsed).some((hostname) => typeof hostname !== 'string')
		)
			throw new Error();
	} catch {
		return 'shared.setupMtaIdentity.invalidEhloHostnames';
	}
}

export function buildMtaIdentityEnv(identity: MtaIdentityDraft): Record<string, string> {
	return {
		IP_POOLS_TRANSACTIONAL: identity.transactionalIps.trim(),
		IP_POOLS_CAMPAIGN: identity.campaignIps.trim(),
		EHLO_HOSTNAME: identity.ehloHostname.trim(),
		...(identity.ehloHostnames.trim() ? { EHLO_HOSTNAMES: identity.ehloHostnames.trim() } : {}),
	};
}
