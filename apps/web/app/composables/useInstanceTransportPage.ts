/**
 * Where the desktop app sends someone who wants to change how the instance
 * sends mail.
 *
 * The transport editor tests and applies credentials through the web app's
 * server routes (`server/api/delivery/validate-transport`, `apply-transport`),
 * which seal secrets on the instance. The desktop app ships the web app as a
 * static build with no server routes, so on desktop those controls are not
 * rendered: the surfaces that lead to them say sending is set up on the
 * instance and open its transport page in the system browser instead. The
 * read-only state (status, readiness) reads Convex and works on desktop.
 */
import { ref } from 'vue';
import { getActiveWorkspace, isDesktopRuntime } from '~/lib/desktop/activeWorkspace';

/** The transport page, on the web app and on the instance alike. */
export const TRANSPORT_PAGE_PATH = '/dashboard/admin/delivery/transport';

/**
 * The readiness fixes that are a change to the transport itself (set one up,
 * add its bounce-report key), as opposed to a look at its state, which the
 * desktop app's own transport page still shows.
 */
const TRANSPORT_CHANGE_ACTIONS: ReadonlySet<string> = new Set([
	'shared.deliveryReadiness.gates.transport.action',
	'shared.deliveryReadiness.gates.transport.actionFeedback',
]);

/** Whether a readiness fix link asks for a change only the instance's editor can make. */
export function isTransportChangeAction(href: string | null, label: unknown): boolean {
	return (
		href === TRANSPORT_PAGE_PATH && typeof label === 'string' && TRANSPORT_CHANGE_ACTIONS.has(label)
	);
}

/** `path` on the connected instance's web origin, or `null` when that is unknown. */
function instanceUrl(path: string): string | null {
	const siteUrl = getActiveWorkspace()?.siteUrl;
	if (!siteUrl) return null;
	try {
		return new URL(path, siteUrl).href;
	} catch {
		return null;
	}
}

export function useInstanceTransportPage() {
	// Stable for the page load: the runtime and the active workspace only change
	// with a reload.
	const isDesktop = isDesktopRuntime();
	const url = isDesktop ? instanceUrl(TRANSPORT_PAGE_PATH) : null;
	/** Set when the shell refused to open the browser, so the page can print the address. */
	const openFailed = ref(false);

	async function openInBrowser(): Promise<void> {
		if (url === null) return;
		try {
			const { openExternal } = await import('@owlat/desktop/src/shell');
			await openExternal(url);
			openFailed.value = false;
		} catch {
			openFailed.value = true;
		}
	}

	return { isDesktop, url, openFailed, openInBrowser };
}
