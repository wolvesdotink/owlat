/**
 * The success hand-off of the desktop "set up a new server" wizard: the
 * provisioned instance's public URL, whether it answers from this machine yet,
 * and connecting it as a workspace.
 *
 * Split from `useServerProvisioning.ts` to keep that file under the size cap;
 * the composable passes in the installer summary the URL comes from.
 */
import type { Ref } from 'vue';
import { canOpenWorkspaceUrl, isLoopbackUrl } from '~/lib/desktop/provisioning';

export function useProvisionedSite(summary: Readonly<Ref<Record<string, unknown> | null>>) {
	// Whether the provisioned site URL has been confirmed reachable from this
	// machine (DNS resolved + TLS issued). Gates the "open workspace" success.
	const siteReachable = ref(false);

	/** The provisioned instance's public URL, if the installer reported one. */
	const siteUrl = computed(() => (summary.value?.['siteUrl'] as string | undefined) ?? null);

	/**
	 * Whether the success state may offer "Open workspace" yet: a public
	 * (non-loopback) URL that we have confirmed actually answers. The installer
	 * finishing is NOT the same as the public URL being usable (DNS/TLS lag).
	 */
	const canOpenWorkspace = computed(() => canOpenWorkspaceUrl(siteUrl.value, siteReachable.value));

	/**
	 * Probe the provisioned site for an owlat instance. Loopback URLs are never
	 * reachable from the desktop (their `localhost` is the app's own machine), so
	 * they short-circuit to unreachable without a network round-trip.
	 */
	async function verifySiteReachable(): Promise<boolean> {
		const url = siteUrl.value;
		if (!url || isLoopbackUrl(url)) {
			siteReachable.value = false;
			return false;
		}
		try {
			const res = await fetch(`${url}/api/instance-info`, { credentials: 'omit' });
			siteReachable.value = res.ok;
		} catch {
			siteReachable.value = false;
		}
		return siteReachable.value;
	}

	/** Connect the freshly-provisioned server as a workspace (reuses the handshake). */
	async function connectWorkspace(): Promise<void> {
		const url = siteUrl.value;
		// Never open a URL the app can't reach: a loopback or not-yet-resolvable
		// address opens the system browser to a dead page and fails silently.
		if (!url || !canOpenWorkspace.value) return;
		const { useDesktopWorkspaces } = await import('~/composables/useDesktopWorkspaces');
		await useDesktopWorkspaces().addWorkspace(url);
	}

	return { siteUrl, siteReachable, canOpenWorkspace, verifySiteReachable, connectWorkspace };
}
