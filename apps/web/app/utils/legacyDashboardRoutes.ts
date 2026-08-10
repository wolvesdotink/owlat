const EXACT_REDIRECTS: Readonly<Record<string, string>> = {
	'/dashboard/delivery': '/dashboard/admin/delivery',
	'/dashboard/delivery/setup': '/dashboard/admin/delivery',
	'/dashboard/delivery/domains': '/dashboard/admin/delivery/domains',
	'/dashboard/delivery/config': '/dashboard/admin/delivery/transport',
	'/dashboard/delivery/provider-routing': '/dashboard/admin/delivery/provider-routing',
	'/dashboard/delivery/deliverability': '/dashboard/admin/delivery/deliverability',
	'/dashboard/delivery/webhooks': '/dashboard/admin/delivery/webhooks',
	'/dashboard/delivery/migrate': '/dashboard/admin/delivery/migrate',
	'/dashboard/delivery/cells': '/dashboard/admin/delivery/advanced/cells',
	'/dashboard/delivery/controls': '/dashboard/admin/delivery/advanced/controls',
	'/dashboard/delivery/measurement': '/dashboard/admin/delivery/advanced/measurement',
	'/dashboard/delivery/independence': '/dashboard/admin/delivery/advanced/independence',
	'/dashboard/settings': '/dashboard/admin',
	'/dashboard/settings/workspace': '/dashboard/admin/instance/general',
	'/dashboard/settings/team': '/dashboard/admin/team',
	'/dashboard/settings/team-inboxes': '/dashboard/admin/team/inboxes',
	'/dashboard/settings/campaign-senders': '/dashboard/admin/team/senders',
	'/dashboard/settings/api': '/dashboard/admin/team/api',
	'/dashboard/settings/api/docs': '/dashboard/admin/team/api/docs',
	'/dashboard/settings/audit': '/dashboard/admin/team/audit',
	'/dashboard/settings/connected-apps': '/dashboard/admin/team/connected-apps',
	'/dashboard/settings/features': '/dashboard/admin/instance/features',
	'/dashboard/settings/agent': '/dashboard/admin/instance/agent',
	'/dashboard/settings/agent-health': '/dashboard/admin/instance/agent-health',
	'/dashboard/settings/ai-provider': '/dashboard/admin/instance/ai-provider',
	'/dashboard/settings/autonomy': '/dashboard/admin/instance/autonomy',
	'/dashboard/settings/email-theme': '/dashboard/admin/instance/email-theme',
	'/dashboard/settings/channels': '/dashboard/admin/instance/channels',
	'/dashboard/settings/plugins': '/dashboard/admin/instance/plugins',
	'/dashboard/settings/forms': '/dashboard/admin/instance/forms',
	'/dashboard/settings/properties': '/dashboard/admin/instance/properties',
	'/dashboard/settings/sealed-mail': '/dashboard/admin/instance/sealed-mail',
	'/dashboard/settings/account': '/dashboard/preferences/account',
	'/dashboard/settings/desktop': '/desktop/settings',
	'/dashboard/settings/operator': '/dashboard/admin/operator',
	'/dashboard/settings/system': '/dashboard/admin/system',
	'/dashboard/settings/backups': '/dashboard/admin/backups',
	'/dashboard/postbox/settings': '/dashboard/preferences',
};

const PREFIX_REDIRECTS: ReadonlyArray<readonly [string, string]> = [
	['/dashboard/settings/plugins/', '/dashboard/admin/instance/plugins/'],
	['/dashboard/postbox/settings/members/', '/dashboard/preferences/members/'],
	['/dashboard/postbox/settings/', '/dashboard/preferences/'],
];

/** Resolve one-release compatibility URLs while preserving path suffixes. */
export function legacyDashboardRedirect(path: string): string | null {
	const exact = EXACT_REDIRECTS[path];
	if (exact) return exact;
	for (const [from, to] of PREFIX_REDIRECTS) {
		if (path.startsWith(from)) return `${to}${path.slice(from.length)}`;
	}
	return null;
}
