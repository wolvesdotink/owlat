import type { Id } from '@owlat/api/dataModel';

/**
 * Dependencies for {@link useAddDomain}. Passed in (rather than reached for)
 * so the orchestration is a plain, directly-testable function — the page owns
 * the concrete mutation runs, modal and toast.
 */
export interface AddDomainFlowDeps {
	/** True when a team is selected (guard before any write). */
	hasActiveOrganization: () => boolean;
	/** Register the domain; resolves to the new id, or `undefined` on failure. */
	createDomain: (args: { domain: string }) => Promise<Id<'domains'> | undefined>;
	/**
	 * Set the per-domain return-path host; resolves to `undefined` when the
	 * operation layer caught + surfaced a failure (any other value = success).
	 */
	setReturnPathHost: (args: {
		domainId: Id<'domains'>;
		returnPathHost: string;
	}) => Promise<unknown>;
	setLoading: (loading: boolean) => void;
	close: () => void;
	showToast: (message: string, type?: 'success' | 'error') => void;
}

/**
 * Add-domain orchestration (piece D3).
 *
 * `create` returns the new domain id but can't take a custom return-path host,
 * so a supplied host is a SECOND write keyed by that id — this flow sequences
 * both. There is deliberately no rollback on a return-path failure: the domain
 * exists and is editable from its row, so we KEEP it but tell the truth (a
 * distinct "added, but the bounce host couldn't be set" message) rather than
 * claim a clean success and hide that the custom host never took.
 */
export function useAddDomain(deps: AddDomainFlowDeps) {
	const handleAddDomain = async (payload: { domain: string; returnPathHost: string | null }) => {
		if (!deps.hasActiveOrganization()) return;

		deps.setLoading(true);
		const domainId = await deps.createDomain({ domain: payload.domain });
		if (domainId === undefined) {
			deps.setLoading(false);
			return;
		}
		const returnPathFailed =
			payload.returnPathHost !== null &&
			(await deps.setReturnPathHost({ domainId, returnPathHost: payload.returnPathHost })) ===
				undefined;
		deps.setLoading(false);
		deps.close();

		if (returnPathFailed) {
			deps.showToast(
				"Domain added, but the custom bounce host couldn't be set — you can set it from the domain's row.",
				'error'
			);
		} else {
			deps.showToast('Domain added successfully. Configure your DNS records to verify.');
		}
	};

	return { handleAddDomain };
}
