/**
 * Conformance pins for the CONTEXTUAL palette providers built here (campaigns
 * list, the focused composer's saved replies). The open conversation's verbs
 * are pinned in `commandPaletteThreadSurfaces.test.ts`.
 *
 * They are the pattern-setters for the provider registry, so what is pinned here
 * is the seam rather than the copy: which group key and order a surface claims,
 * that it filters itself by the palette query, and — the subtle one — that the
 * ids it shares with core providers make the shell drop the duplicate instead of
 * printing the same row twice. A future surface that copies these gets the same
 * guarantees only if these rules stay true.
 */
import { describe, it, expect, vi } from 'vitest';
import type { CommandPaletteProvider } from '../commandPaletteRegistry';
import { resolvePaletteGroups } from '../commandPaletteRegistry';
import { mergeGroups } from '../commandPalette';
import {
	CAMPAIGNS_LIST_ROUTE,
	CAMPAIGN_COMMAND_GROUP_KEY,
	CAMPAIGN_COMMAND_PROVIDER_ID,
	CAMPAIGN_COMMAND_PROVIDER_PRIORITY,
	type CampaignSurfaceRow,
	buildCampaignSurfaceGroups,
	buildSavedReplyGroups,
} from '../commandPaletteSurfaces';
import { createTestI18n } from '~/__tests__/i18n';
import { MegaphoneIcon } from '@coolicons/vue';

const { t } = createTestI18n().global;
/** The surfaces resolve their own copy, so the assertions read as words. */
const translate = (key: string) => t(key);

const ROWS: CampaignSurfaceRow[] = [
	{ id: 'cmp_1', name: 'Spring launch', opensReport: true },
	{ id: 'cmp_2', name: 'Winter draft', opensReport: false },
];

function campaignGroups(query = '', rows: CampaignSurfaceRow[] = ROWS, overrides = {}) {
	return buildCampaignSurfaceGroups(
		{
			rows: () => rows,
			t: translate,
			onNewCampaign: () => {},
			onOpenCampaign: () => {},
			...overrides,
		},
		query
	);
}

describe('buildCampaignSurfaceGroups', () => {
	it('leads with the page verbs, above the core Create group', () => {
		const [group] = campaignGroups();
		expect(group).toMatchObject({
			key: CAMPAIGN_COMMAND_GROUP_KEY,
			heading: 'On this page',
			order: 0,
			cap: 6,
			mode: 'commands',
		});
	});

	it('opens a sent campaign at its report and an unsent one at its editor', () => {
		const onOpenCampaign = vi.fn();
		const [group] = campaignGroups('', ROWS, { onOpenCampaign });
		const items = group!.items;
		expect(items.map((item) => item.label)).toEqual([
			'New campaign',
			'Spring launch',
			'Winter draft',
		]);
		expect(items[1]?.subtitle).toBe('Open report');
		expect(items[2]?.subtitle).toBe('Open campaign');
		items[1]?.run();
		expect(onOpenCampaign).toHaveBeenCalledWith(ROWS[0]);
	});

	it('filters its own rows by the palette query', () => {
		const [group] = campaignGroups('winter');
		expect(group!.items.map((item) => item.label)).toEqual(['Winter draft']);
	});

	it('gives a row the id of its object-search hit so the two never both render', () => {
		const [group] = campaignGroups();
		expect(group!.items.map((item) => item.id)).toEqual([
			'verb:new-campaign',
			'search:cmp_1',
			'search:cmp_2',
		]);
	});
});

describe('the campaigns provider inside the shell', () => {
	/** A stand-in for the core providers the shell always consults first. */
	const core: CommandPaletteProvider[] = [
		{
			id: 'core:verbs',
			priority: 20,
			build: () => [
				{
					key: 'verbs',
					heading: 'Create',
					order: 5,
					items: [
						{
							id: 'verb:new-campaign',
							label: 'New campaign',
							icon: MegaphoneIcon,
							run: () => {},
						},
					],
				},
			],
		},
	];

	const campaigns: CommandPaletteProvider = {
		id: CAMPAIGN_COMMAND_PROVIDER_ID,
		priority: CAMPAIGN_COMMAND_PROVIDER_PRIORITY,
		matchRoute: (path) => path === CAMPAIGNS_LIST_ROUTE,
		build: ({ query }) => campaignGroups(query),
	};

	function resolve(path: string) {
		return mergeGroups(
			resolvePaletteGroups(
				core,
				[campaigns],
				{ path, isFlagEnabled: () => true },
				{ query: '', mode: 'all' }
			)
		);
	}

	it('shows "New campaign" once — the core verb wins, the surface row is dropped', () => {
		const groups = resolve(CAMPAIGNS_LIST_ROUTE);
		const rendered = groups.flatMap((group) =>
			group.items.map((item) => `${group.key}:${item.id}`)
		);
		expect(rendered.filter((entry) => entry.endsWith('verb:new-campaign'))).toEqual([
			'verbs:verb:new-campaign',
		]);
		// …and the page's own rows survive, above the core group.
		expect(groups.map((group) => group.key)).toEqual([CAMPAIGN_COMMAND_GROUP_KEY, 'verbs']);
	});

	it('contributes nothing once the route leaves the list', () => {
		expect(resolve('/dashboard/campaigns/new').map((group) => group.key)).toEqual(['verbs']);
	});
});

describe('the focused composer’s saved replies', () => {
	const replies = [
		{ _id: 'sn_1', name: 'Refund policy', shortcut: 'refund' },
		{ _id: 'sn_2', name: 'Opening hours', shortcut: '' },
	];
	function groups(query = '') {
		const onInsert = vi.fn();
		const onSaveCurrent = vi.fn();
		const built = buildSavedReplyGroups(
			{ replies: () => replies, t: translate, onInsert, onSaveCurrent },
			query
		);
		return { built, onInsert, onSaveCurrent };
	}

	it('offers one "Insert saved reply…" submenu and "Save as reply" while nothing is typed', () => {
		const [group] = groups().built;
		expect(group?.heading).toBe('Saved replies');
		expect(group?.mode).toBe('commands');
		expect(group?.items.map((item) => item.label)).toEqual([
			'Insert saved reply…',
			'Save as reply',
		]);
		const submenu = group!.items[0]!;
		expect(submenu.argument?.options.map((option) => [option.label, option.subtitle])).toEqual([
			['Refund policy', ';refund'],
			['Opening hours', undefined],
		]);
	});

	it('also lists the matching replies directly once something is typed, shortcut included', () => {
		expect(groups('refund').built[0]?.items.map((item) => item.label)).toEqual(['Refund policy']);
		expect(groups('insert').built[0]?.items.map((item) => item.label)).toEqual([
			'Insert saved reply…',
		]);
	});

	it('inserts the chosen reply from the submenu or a direct row, or opens "Save as reply"', () => {
		const { built, onInsert, onSaveCurrent } = groups();
		built[0]?.items[0]?.argument?.options[1]?.run();
		expect(onInsert).toHaveBeenCalledWith('sn_2');
		built[0]?.items[1]?.run();
		expect(onSaveCurrent).toHaveBeenCalled();
		const typed = groups('opening');
		typed.built[0]?.items[0]?.run();
		expect(typed.onInsert).toHaveBeenCalledWith('sn_2');
	});

	it('offers only "Save as reply" when there are no replies yet', () => {
		const built = buildSavedReplyGroups(
			{ replies: () => [], t: translate, onInsert: vi.fn(), onSaveCurrent: vi.fn() },
			''
		);
		expect(built[0]?.items.map((item) => item.id)).toEqual(['saved-reply:save-current']);
	});
});
