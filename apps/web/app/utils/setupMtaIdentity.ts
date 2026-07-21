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
		return 'Enter the transactional and campaign sending IPs plus the EHLO hostname used by their PTR records.';
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
		return 'Per-IP EHLO overrides must be a JSON object mapping IP to hostname.';
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
