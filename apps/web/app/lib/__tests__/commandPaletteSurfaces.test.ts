/**
 * Conformance pins for the two CONTEXTUAL palette providers (campaigns list,
 * open mail conversation).
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
	POSTBOX_THREAD_COMMAND_GROUP_KEY,
	POSTBOX_THREAD_COMMAND_PROVIDER_PRIORITY,
	type CampaignSurfaceRow,
	buildCampaignSurfaceGroups,
	buildThreadSurfaceGroups,
} from '../commandPaletteSurfaces';
import { POSTBOX_COMMAND_PROVIDER_PRIORITY } from '~/composables/postbox/usePostboxCommandSurface';
import { createTestI18n } from '~/__tests__/i18n';

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

function threadGroups(query = '', overrides = {}) {
	return buildThreadSurfaceGroups(
		{
			subject: () => 'Invoice #12',
			t: translate,
			onArchive: () => {},
			onReply: () => {},
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
							icon: 'lucide:megaphone',
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

describe('buildThreadSurfaceGroups', () => {
	it('offers reply and archive against the open conversation', () => {
		const [group] = threadGroups();
		expect(group).toMatchObject({ key: POSTBOX_THREAD_COMMAND_GROUP_KEY, order: 0 });
		expect(group!.items.map((item) => [item.id, item.label, item.subtitle])).toEqual([
			['postbox:thread-reply', 'Reply', 'Invoice #12'],
			['postbox:thread-archive', 'Archive conversation', 'Invoice #12'],
		]);
	});

	it('runs the reader action it was handed, not a broadcast', () => {
		const onArchive = vi.fn();
		const [group] = threadGroups('archive', { onArchive });
		expect(group!.items).toHaveLength(1);
		group!.items[0]?.run();
		expect(onArchive).toHaveBeenCalledTimes(1);
	});

	it('drops the subject line when the message has no subject', () => {
		const [group] = threadGroups('', { subject: () => '   ' });
		expect(group!.items.every((item) => item.subtitle === undefined)).toBe(true);
	});

	it('is consulted before the Postbox layout provider within the external tier', () => {
		expect(POSTBOX_THREAD_COMMAND_PROVIDER_PRIORITY).toBeLessThan(
			POSTBOX_COMMAND_PROVIDER_PRIORITY
		);
	});
});
