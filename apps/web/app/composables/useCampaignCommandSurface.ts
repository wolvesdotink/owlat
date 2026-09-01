import {
	CAMPAIGNS_LIST_ROUTE,
	CAMPAIGN_COMMAND_PROVIDER_ID,
	CAMPAIGN_COMMAND_PROVIDER_PRIORITY,
	type CampaignSurfaceRow,
	buildCampaignSurfaceGroups,
} from '~/lib/commandPaletteSurfaces';

/** The rows the page is showing, read lazily so the page keeps owning them. */
export interface CampaignCommandSurfaceSources {
	rows: () => readonly CampaignSurfaceRow[];
}

/**
 * Registers the campaigns command center as a palette provider while it is
 * mounted, so ⌘K on that page offers what the page can do — create a campaign,
 * or open the report/editor of a campaign already in the list — instead of only
 * where you can go.
 *
 * Route-gated to the list itself and flag-gated to `campaigns`, so the group can
 * never leak onto another surface even if a registration outlived a route
 * change. `rows` is read inside `build`, so the palette always sees the pills'
 * current selection without a watcher.
 */
export function useCampaignCommandSurface(sources: CampaignCommandSurfaceSources): void {
	const { t } = useI18n();

	registerCommandPaletteProvider({
		id: CAMPAIGN_COMMAND_PROVIDER_ID,
		priority: CAMPAIGN_COMMAND_PROVIDER_PRIORITY,
		flag: 'campaigns',
		matchRoute: (path) => path === CAMPAIGNS_LIST_ROUTE,
		build: ({ query }) =>
			buildCampaignSurfaceGroups(
				{
					rows: sources.rows,
					t,
					onNewCampaign: () => void navigateTo('/dashboard/campaigns/new'),
					// Same destination rule as a row click on the page: a sent or
					// sending campaign opens its report, everything else the editor.
					onOpenCampaign: (row) =>
						void navigateTo(
							`/dashboard/campaigns/${row.id}/${row.opensReport ? 'report' : 'edit'}`
						),
				},
				query
			),
	});
}
