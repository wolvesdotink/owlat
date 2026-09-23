/**
 * What a visitor sees when they open an instance's own address, and what the
 * sign-in page tells them about the workspace behind it.
 *
 * A self-hosted instance belongs to one company. Its root is that company's
 * door, not the Owlat product site: the hero, the "Get started" button (which
 * lands on "Registration is disabled" on an invite-only instance) and the
 * vendor's legal footer only make sense on the hosted marketing deployment.
 *
 * Pure, so the three decisions are unit-testable without mounting a page.
 */

/** The public runtime-config fields these decisions read. */
export interface InstanceEntryConfig {
	/** `'selfhost'` (default) or `'hosted'`. */
	deploymentMode?: string;
	/** The operator's company name (NUXT_PUBLIC_COMPANY_NAME); empty when unset. */
	companyName?: string;
}

/**
 * Where `/` sends a visitor, or `null` to render the product hero.
 *
 * Only the hosted marketing deployment keeps the hero. Everywhere else the
 * root is the sign-in page; a visitor who is already signed in is sent on to
 * the dashboard by the sign-in page's own guest middleware.
 */
export function instanceRootRedirect(config: InstanceEntryConfig): string | null {
	return config.deploymentMode === 'hosted' ? null : '/auth/login';
}

/** The workspace name to greet a visitor with, or `null` when none is configured. */
export function workspaceDisplayName(config: InstanceEntryConfig): string | null {
	const name = config.companyName?.trim();
	return name ? name : null;
}

/**
 * Whether the operator configured their own legal details. The Terms and
 * Imprint pages render the `company*` runtime config, so without a company
 * name they would be empty pages; the footer shows "Powered by Owlat" instead.
 */
export function hasOperatorLegalPages(config: InstanceEntryConfig): boolean {
	return workspaceDisplayName(config) !== null;
}

/**
 * Whether the sign-in page may offer "Create an account".
 *
 * Registration is invite-only past the first admin (enforced on the server in
 * `auth/registrationGate.ts`): the register page only shows its form when the
 * visitor arrived from an invitation. Offering the link anywhere else leads to
 * "Registration is disabled", so it is shown only when the sign-in page itself
 * was reached from an invitation (`?redirect=/invite/accept…`).
 */
export function registrationOpenFor(redirect: unknown): boolean {
	if (typeof redirect !== 'string' || redirect === '') return false;
	let decoded = redirect;
	try {
		decoded = decodeURIComponent(redirect);
	} catch {
		return false;
	}
	return decoded.startsWith('/invite/accept');
}
