/**
 * The member's MCP clients (AI clients reading their mail over MCP): list,
 * connect and revoke, plus the server address a client is pointed at.
 */

import { api } from '@owlat/api';
import type { Id } from '@owlat/api/dataModel';

/** Shown instead of a host when the instance has no public site URL configured. */
const SITE_URL_PLACEHOLDER = 'https://<your-convex-site-url>';

export function useMcpClients() {
	const { t } = useI18n();
	const runtimeConfig = useRuntimeConfig();
	const { data, isLoading, error, refetch } = useConvexQuery(api.mcp.clients.list, () => ({}));
	const clients = computed(() => data.value ?? []);

	// The MCP route is an HTTP action, served on the Convex SITE origin.
	const serverUrl = computed(() => {
		const base = (runtimeConfig.public.convexSiteUrl || '').replace(/\/+$/, '');
		return `${base || SITE_URL_PLACEHOLDER}/mcp/postbox`;
	});

	const createOperation = useBackendOperation(api.mcp.clients.create, {
		label: () => t('shared.useMcpClients.createOperation'),
	});
	const revokeOperation = useBackendOperation(api.mcp.clients.revoke, {
		label: () => t('shared.useMcpClients.revokeOperation'),
	});

	function create(label: string, mailboxIds: Id<'mailboxes'>[]) {
		return createOperation.run({ label, mailboxIds });
	}

	async function revoke(clientId: Id<'mcpClients'>) {
		await revokeOperation.run({ clientId });
	}

	return { clients, isLoading, error, refetch, serverUrl, create, revoke };
}
