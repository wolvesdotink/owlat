export const DELIVERABILITY_PROBE_LOCAL_PREFIX = 'deliverability-probe+';

const TOKEN_PATTERN = /^[0-9a-z]{1,9}\.[A-Za-z0-9_-]{12}\.[A-Za-z0-9_-]{16}$/;

export function isDeliverabilityProbeTokenFormat(token: string): boolean {
	return TOKEN_PATTERN.test(token);
}
