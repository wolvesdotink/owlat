/**
 * Where a campaign opens. Once a campaign is sending or sent the editor refuses
 * it, so every link to a campaign goes to its report from then on, however long
 * ago it went out.
 */
export function campaignOpensReport(status: string): boolean {
	return status === 'sent' || status === 'sending';
}

export function campaignHref(campaign: { _id: string; status: string }): string {
	const page = campaignOpensReport(campaign.status) ? 'report' : 'edit';
	return `/dashboard/campaigns/${campaign._id}/${page}`;
}
