/**
 * Pure group builders for the CONTEXTUAL palette providers a mounted surface
 * registers ("on this page" verbs).
 *
 * Composition lives here as pure functions (ids, priorities, group
 * keys/orders/caps, route gates), and the composables beside them
 * (`useCampaignCommandSurface`, `useComposerSavedReplyPicker`) inject the
 * reactive reads, the translator and the `run` closures. Same split as
 * `commandPaletteCore.ts`, same reason: the composition is unit-testable without
 * mounting a page. The open conversation's verbs have their own module,
 * `commandPaletteThreadSurfaces.ts`.
 *
 * Two item ids are deliberately SHARED with core providers rather than made
 * unique. `collectProviderGroups` consults core first and drops an id it has
 * already emitted, so a shared id means "offer this only where the core palette
 * does not already" — the surface fills the gap instead of printing a second
 * identical row.
 */
import { type PaletteGroup, type PaletteItem, filterItems } from './commandPalette';
import { BookmarkPlusIcon, ChatTextIcon, MegaphoneIcon } from '@coolicons/vue';

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
			icon: MegaphoneIcon,
			run: deps.onNewCampaign,
		},
		...deps.rows().map((row) => ({
			// Shared with the object-search hit for the same campaign, so a query
			// that reaches the search index shows one row, not two — and an idle
			// palette (search needs two characters) still lists what is on screen.
			id: `search:${row.id}`,
			objectId: row.id,
			label: row.name,
			subtitle: deps.t(
				row.opensReport
					? 'shared.commandPaletteSurfaces.campaigns.openReport'
					: 'shared.commandPaletteSurfaces.campaigns.openCampaign'
			),
			icon: MegaphoneIcon,
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

// ── Saved replies of the focused composer ───────────────────────────────────

/**
 * Registry id PREFIX of the saved-reply provider: every mounted composer (the
 * compose page, Answer mode, a Team inbox reply) registers its own, and only
 * the one the person was last typing in contributes.
 */
export const SAVED_REPLY_COMMAND_PROVIDER_ID_PREFIX = 'surface:saved-replies';

/** Consulted before the open conversation's verbs: the composer has the focus. */
export const SAVED_REPLY_COMMAND_PROVIDER_PRIORITY = 1;

/** How many rows the group lists; the submenu (and the composer's picker) has them all. */
const SAVED_REPLY_GROUP_CAP = 8;

export interface SavedReplySurfaceDeps {
	/** The replies, already in the picker's order (most used first). */
	replies: () => { _id: string; name: string; shortcut: string }[];
	t: (key: string) => string;
	onInsert: (replyId: string) => void;
	onSaveCurrent: () => void;
}

/**
 * The focused composer's saved replies: "Insert saved reply…" (a submenu of every
 * reply, most used first) and "Save as reply". Once something is typed the
 * matching replies also show directly, so a reply found by its name or `;`
 * shortcut is one Enter away, not two. Pure.
 */
export function buildSavedReplyGroups(deps: SavedReplySurfaceDeps, query: string): PaletteGroup[] {
	const replyItems: PaletteItem[] = deps.replies().map((reply) => ({
		id: `saved-reply:${reply._id}`,
		label: reply.name,
		...(reply.shortcut ? { subtitle: `;${reply.shortcut}` } : {}),
		icon: ChatTextIcon,
		run: () => deps.onInsert(reply._id),
	}));
	const items: PaletteItem[] = [];
	if (replyItems.length > 0) {
		items.push({
			id: 'saved-reply:insert',
			label: deps.t('shared.savedReplies.insertSubmenu'),
			icon: ChatTextIcon,
			run: () => {},
			argument: {
				promptKey: 'shared.savedReplies.paletteHeading',
				headingKey: 'shared.savedReplies.paletteHeading',
				icon: ChatTextIcon,
				options: replyItems.map((item) => ({
					id: item.id,
					label: item.label,
					...(item.subtitle ? { subtitle: item.subtitle } : {}),
					run: item.run,
				})),
			},
		});
	}
	items.push({
		id: 'saved-reply:save-current',
		label: deps.t('shared.savedReplies.saveCurrent'),
		icon: BookmarkPlusIcon,
		run: deps.onSaveCurrent,
	});
	const typed = query.trim() !== '';
	return [
		{
			key: 'saved-replies',
			heading: deps.t('shared.savedReplies.paletteHeading'),
			order: 0,
			cap: SAVED_REPLY_GROUP_CAP,
			mode: 'commands',
			items: filterItems(typed ? [...items, ...replyItems] : items, query),
		},
	];
}
