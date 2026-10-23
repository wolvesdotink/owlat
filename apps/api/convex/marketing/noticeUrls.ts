/**
 * The in-app paths marketing notices open. One home because the notice rows,
 * the in-app reader and the push copy all build them, and a path that drifts
 * between them would open a different page from the toast than from the phone.
 */

export function campaignReportUrl(campaignId: string): string {
	return `/dashboard/campaigns/${campaignId}/report`;
}

export function campaignEditUrl(campaignId: string): string {
	return `/dashboard/campaigns/${campaignId}/edit`;
}

/** The campaign page with the cancel confirmation open; the page asks before it cancels. */
export function campaignCancelUrl(campaignId: string): string {
	return `${campaignEditUrl(campaignId)}?intent=cancel`;
}

export function automationUrl(automationId: string): string {
	return `/dashboard/automations/${automationId}`;
}

/** The sending domains page, scrolled to this domain. */
export function sendingDomainUrl(domain: string): string {
	return `/dashboard/admin/delivery/domains?domain=${encodeURIComponent(domain)}`;
}

export const DELIVERABILITY_URL = '/dashboard/admin/delivery/deliverability';
