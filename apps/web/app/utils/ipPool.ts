/**
 * Pure helper for the provider-routing IP-pool override (provider-routing.vue).
 *
 * The field stays free-text (a future MTA build could expose more pools), but
 * the known set comes from the backend `providerRoutes.listIpPools` query so we
 * can autocomplete it and warn when an operator types a pool the MTA does not
 * route through — an unknown pool name is silently ignored by the MTA, so the
 * warning is the only signal the operator gets.
 */

/**
 * Warning text when a typed IP-pool name is not one the backend reports, or
 * null when there is nothing to warn about. Returns null when the value is
 * blank (the field is optional) or while the known-pool list is still loading
 * (`undefined`/`null`).
 */
export function unknownIpPoolWarning(
	value: string,
	knownPools: string[] | undefined | null,
): string | null {
	const trimmed = value.trim();
	if (!trimmed) return null;
	if (!knownPools) return null;
	if (knownPools.includes(trimmed)) return null;
	return `"${trimmed}" is not a known MTA IP pool. Known pools: ${knownPools.join(', ')}.`;
}
