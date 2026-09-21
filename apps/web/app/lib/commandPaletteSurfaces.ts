/**
 * Pure group builders for the CONTEXTUAL palette providers a mounted surface
 * registers ("on this page" verbs).
 *
 * The provider registry (`./commandPaletteRegistry`) has always supported this;
 * until now the Postbox layout was its only registrant, so nothing proved that a
 * second and third surface could contribute without stepping on each other.
 * These two — the campaigns command center and the open mail conversation — are
 * the pattern-setters: composition lives here as pure functions (ids,
 * priorities, group keys/orders/caps, route gates), and the composables beside
 * them (`useCampaignCommandSurface`, `usePostboxThreadCommandSurface`) inject
 * the reactive reads, the translator and the `run` closures. Same split as
 * `commandPaletteCore.ts`, same reason: the composition is unit-testable without
 * mounting a page.
 *
 * Two item ids are deliberately SHARED with core providers rather than made
 * unique. `collectProviderGroups` consults core first and drops an id it has
 * already emitted, so a shared id means "offer this only where the core palette
 * does not already" — the surface fills the gap instead of printing a second
 * identical row.
 */
import { type PaletteGroup, type PaletteItem, filterItems } from './commandPalette';

// ── Campaigns command center ────────────────────────────────────────────────

/** Stable registry id (and dedup key) of the campaigns list provider. */
export const CAMPAIGN_COMMAND_PROVIDER_ID = 'surface:campaigns';

/**
 * Orders campaigns within the EXTERNAL provider tier only — core providers are
 * consulted first whatever this says, and the render position comes from each
 * group's `order`.
 */
export const CAMPAIGN_COMMAND_PROVIDER_PRIORITY = 10;

/** The one route the campaigns provider answers on. */
export const CAMPAIGNS_LIST_ROUTE = '/dashboard/campaigns';

/** Group key of the campaigns "on this page" block. */
export const CAMPAIGN_COMMAND_GROUP_KEY = 'campaigns-surface';

/** A campaign row as the palette needs it — no stats, no attention roll-up. */
export interface CampaignSurfaceRow {
	id: string;
	name: string;
	/** Sent/sending campaigns open their report; everything else, the editor. */
	opensReport: boolean;
}

export interface CampaignSurfaceDeps {
	/** The rows the page is currently showing, in its own order. */
	rows: () => readonly CampaignSurfaceRow[];
	/** Translator — the composable owns `useI18n`, this module cannot. */
	t: (key: string) => string;
	onNewCampaign: () => void;
	onOpenCampaign: (row: CampaignSurfaceRow) => void;
}

/**
 * The campaigns list's contextual group: create a campaign, or jump straight to
 * the report/editor of a campaign the list is already showing. Filtered by the
 * palette query with the shared fuzzy scorer. Pure.
 */
export function buildCampaignSurfaceGroups(
	deps: CampaignSurfaceDeps,
	query: string
): PaletteGroup[] {
	const items: PaletteItem[] = [
		{
			// Shared with the core "Create" verb on purpose (see the module doc):
			// wherever that verb is enabled it wins and this row never renders.
			id: 'verb:new-campaign',
			label: deps.t('shared.useCommandPaletteProviders.newCampaign'),
			icon: 'lucide:megaphone',
			run: deps.onNewCampaign,
		},
		...deps.rows().map((row) => ({
			// Shared with the object-search hit for the same campaign, so a query
			// that reaches the search index shows one row, not two — and an idle
			// palette (search needs two characters) still lists what is on screen.
			id: `search:${row.id}`,
			label: row.name,
			subtitle: deps.t(
				row.opensReport
					? 'shared.commandPaletteSurfaces.campaigns.openReport'
					: 'shared.commandPaletteSurfaces.campaigns.openCampaign'
			),
			icon: 'lucide:megaphone',
			run: () => deps.onOpenCampaign(row),
		})),
	];
	return [
		{
			key: CAMPAIGN_COMMAND_GROUP_KEY,
			heading: deps.t('shared.commandPaletteSurfaces.campaigns.heading'),
			// Above the core verbs (order 5): what this page can do comes first.
			order: 0,
			cap: 6,
			mode: 'commands',
			items: filterItems(items, query),
		},
	];
}

// ── Open mail conversation ──────────────────────────────────────────────────

/**
 * Registry id PREFIX of the thread provider. Two readers can be mounted at once
 * (the folder reader and the Today overlay), so each instance claims its own id
 * — first-claimant-wins would otherwise let the survivor of a pair be the one
 * whose registration was ignored, leaving the palette with no thread verbs at
 * all. The shared GROUP key below collapses the duplicate contributions instead.
 */
export const POSTBOX_THREAD_COMMAND_PROVIDER_ID_PREFIX = 'surface:postbox-thread';

/** Consulted before the Postbox layout's provider (15) within the external tier. */
export const POSTBOX_THREAD_COMMAND_PROVIDER_PRIORITY = 5;

/** Group key of the open-conversation block (dedupes two mounted readers). */
export const POSTBOX_THREAD_COMMAND_GROUP_KEY = 'postbox-thread';

export interface ThreadSurfaceDeps {
	/** Subject of the open message, shown as the muted "what this acts on" line. */
	subject: () => string;
	t: (key: string) => string;
	onArchive: () => void;
	onReply: () => void;
}

/**
 * The open conversation's contextual group. Archive and Reply are the two verbs
 * the reader's own toolbar leads with, and neither was reachable from ⌘K: the
 * Postbox layout's provider only carries the actions its overflow menu hides
 * (reply-all, forward, spam, …). Pure.
 */
export function buildThreadSurfaceGroups(deps: ThreadSurfaceDeps, query: string): PaletteGroup[] {
	const subject = deps.subject().trim();
	const items: PaletteItem[] = [
		{
			id: 'postbox:thread-reply',
			label: deps.t('shared.commandPaletteSurfaces.thread.reply'),
			...(subject ? { subtitle: subject } : {}),
			icon: 'lucide:reply',
			run: deps.onReply,
		},
		{
			id: 'postbox:thread-archive',
			label: deps.t('shared.commandPaletteSurfaces.thread.archive'),
			...(subject ? { subtitle: subject } : {}),
			icon: 'lucide:archive',
			run: deps.onArchive,
		},
	];
	return [
		{
			key: POSTBOX_THREAD_COMMAND_GROUP_KEY,
			heading: deps.t('shared.commandPaletteSurfaces.thread.heading'),
			// Same tier as the Postbox layout's mailbox actions (0); the lower
			// provider priority puts the open conversation first.
			order: 0,
			mode: 'commands',
			items: filterItems(items, query),
		},
	];
}
