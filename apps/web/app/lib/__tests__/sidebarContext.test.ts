/**
 * Pure-logic coverage for the sidebar Conversations ↔ Sending context model:
 *   - route ownership: which context owns a path, shared routes → null
 *   - section partitioning: context blocks + shared block, order preserved
 *   - switch-target resolution: last-visited > preferred home > first item
 *   - the shown context: the active one with the toggle, else the only one left
 */
import { describe, it, expect } from 'vitest';
import type { SectionKey } from '~/composables/useSidebarState';
import {
	contextForPath,
	readLastVisitedRoutes,
	resolveSwitchTarget,
	sendingZones,
	shownSidebarContext,
	splitSectionsByContext,
} from '../sidebarContext';
import type { FeatureFlagKey } from '@owlat/shared/featureFlags';
import type { OrganizationRole } from '~/composables/useOrganization';

function section(key: SectionKey, hrefs: string[]) {
	return { key, items: hrefs.map((href) => ({ href })) };
}

describe('contextForPath', () => {
	it('assigns inbox routes to the inbox context', () => {
		expect(contextForPath('/dashboard/inbox')).toBe('inbox');
		expect(contextForPath('/dashboard/inbox/review')).toBe('inbox');
		expect(contextForPath('/dashboard/postbox/inbox')).toBe('inbox');
		expect(contextForPath('/dashboard/chat')).toBe('inbox');
		expect(contextForPath('/dashboard/chat/room-1')).toBe('inbox');
	});

	it('assigns marketing routes to the marketing context', () => {
		expect(contextForPath('/dashboard/campaigns')).toBe('marketing');
		expect(contextForPath('/dashboard/campaigns/new')).toBe('marketing');
		expect(contextForPath('/dashboard/automations')).toBe('marketing');
		expect(contextForPath('/dashboard/send/transactional')).toBe('marketing');
		expect(contextForPath('/dashboard/audience/contacts')).toBe('marketing');
		expect(contextForPath('/dashboard/admin/delivery')).toBeNull();
	});

	it('claims Today, the Answer queue and All inboxes for Conversations', () => {
		expect(contextForPath('/dashboard')).toBe('inbox');
		expect(contextForPath('/dashboard/answer')).toBe('inbox');
		expect(contextForPath('/dashboard/inboxes')).toBe('inbox');
		expect(contextForPath('/dashboard/marketing')).toBe('marketing');
	});

	it('claims Knowledge for Conversations, where its sidebar row lives', () => {
		expect(contextForPath('/dashboard/knowledge')).toBe('inbox');
		expect(contextForPath('/dashboard/knowledge/graph')).toBe('inbox');
	});

	it('returns null for shared routes', () => {
		expect(contextForPath('/dashboard/assistant')).toBeNull();
		expect(contextForPath('/dashboard/admin/instance/features')).toBeNull();
	});

	it('matches whole path segments only', () => {
		expect(contextForPath('/dashboard/answers')).toBeNull();
		expect(contextForPath('/dashboard/sendgrid')).toBeNull();
		expect(contextForPath('/dashboard/marketingx')).toBeNull();
	});

	it('ignores query and hash', () => {
		expect(contextForPath('/dashboard/postbox/inbox#postbox-for-you')).toBe('inbox');
		expect(contextForPath('/dashboard/chat?room=1')).toBe('inbox');
		expect(contextForPath('/dashboard/campaigns?status=draft#top')).toBe('marketing');
	});
});

describe('splitSectionsByContext', () => {
	it('partitions sections into context and shared blocks, order preserved', () => {
		const split = splitSectionsByContext([
			section('inbox', ['/dashboard/inbox']),
			section('postbox', ['/dashboard/postbox/inbox']),
			section('chat', ['/dashboard/chat']),
			section('assistant', ['/dashboard/assistant']),
			section('send', ['/dashboard/send']),
			section('transactional', ['/dashboard/send/transactional']),
			section('audience', ['/dashboard/audience']),
			section('administration', ['/dashboard/admin/delivery']),
			section('knowledge', ['/dashboard/knowledge']),
			section('preferences', ['/dashboard/preferences']),
		]);
		expect(split.inbox.map((s) => s.key)).toEqual(['inbox', 'postbox', 'chat', 'knowledge']);
		expect(split.marketing.map((s) => s.key)).toEqual(['send', 'transactional', 'audience']);
		expect(split.shared.map((s) => s.key)).toEqual(['assistant', 'administration', 'preferences']);
	});

	it('yields an empty context when its sections were flag-filtered out', () => {
		const split = splitSectionsByContext([
			section('send', ['/dashboard/send']),
			section('preferences', ['/dashboard/preferences']),
		]);
		expect(split.inbox).toEqual([]);
		expect(split.marketing.map((s) => s.key)).toEqual(['send']);
	});
});

describe('shownSidebarContext', () => {
	const both = splitSectionsByContext([
		section('inbox', ['/dashboard/inbox']),
		section('send', ['/dashboard/send']),
	]);
	const sendingOnly = splitSectionsByContext([
		section('send', ['/dashboard/send']),
		section('preferences', ['/dashboard/preferences']),
	]);
	const conversationsOnly = splitSectionsByContext([section('inbox', ['/dashboard/inbox'])]);

	it('shows the active context while both contexts have sections', () => {
		expect(shownSidebarContext('inbox', both)).toBe('inbox');
		expect(shownSidebarContext('marketing', both)).toBe('marketing');
	});

	it('shows Sending in a workspace with only Sending features, on any route', () => {
		expect(shownSidebarContext('inbox', sendingOnly)).toBe('marketing');
		expect(shownSidebarContext('marketing', sendingOnly)).toBe('marketing');
	});

	it('shows Conversations when it is the only context, or when neither is left', () => {
		expect(shownSidebarContext('marketing', conversationsOnly)).toBe('inbox');
		expect(shownSidebarContext('marketing', splitSectionsByContext([]))).toBe('inbox');
	});
});

describe('resolveSwitchTarget', () => {
	const sections = [
		section('inbox', ['/dashboard/inbox', '/dashboard/inbox/review']),
		section('postbox', ['/dashboard/postbox/inbox', '/dashboard/postbox/sent']),
		section('send', ['/dashboard/campaigns', '/dashboard/send']),
		section('audience', ['/dashboard/audience']),
	];

	it('prefers the last-visited route when it belongs to the target context', () => {
		expect(resolveSwitchTarget('inbox', '/dashboard/postbox/sent', sections)).toBe(
			'/dashboard/postbox/sent'
		);
		expect(resolveSwitchTarget('marketing', '/dashboard/campaigns/42?tab=stats', sections)).toBe(
			'/dashboard/campaigns/42?tab=stats'
		);
	});

	it('ignores a last-visited route whose feature is now off', () => {
		const withOverview = [...sections, section('send', ['/dashboard/marketing'])];
		const campaignsOff = (href: string) => !href.startsWith('/dashboard/campaigns');
		expect(
			resolveSwitchTarget('marketing', '/dashboard/campaigns/42', withOverview, campaignsOff)
		).toBe('/dashboard/marketing');
	});

	it('ignores a last-visited route the target context does not own', () => {
		expect(resolveSwitchTarget('inbox', '/dashboard/campaigns', sections)).toBe('/dashboard');
	});

	it('falls back to the preferred home: Today for Conversations, the overview for Marketing', () => {
		expect(resolveSwitchTarget('inbox', undefined, sections)).toBe('/dashboard');
		const withOverview = [...sections, section('send', ['/dashboard/marketing'])];
		expect(resolveSwitchTarget('marketing', undefined, withOverview)).toBe('/dashboard/marketing');
	});

	it('falls back to the first visible item when the preferred home was flag-filtered out', () => {
		const noPostbox = [
			section('inbox', ['/dashboard/inbox']),
			section('send', ['/dashboard/send']),
		];
		expect(resolveSwitchTarget('marketing', undefined, noPostbox)).toBe('/dashboard/send');
	});

	it('lands on the transactional list when Marketing has no overview', () => {
		const transactionalOnly = [
			section('inbox', ['/dashboard/inbox']),
			section('send', ['/dashboard/send', '/dashboard/marketing/deleted']),
			section('transactional', ['/dashboard/send/transactional']),
			section('audience', ['/dashboard/audience/contacts']),
		];
		expect(resolveSwitchTarget('marketing', undefined, transactionalOnly)).toBe(
			'/dashboard/send/transactional'
		);
	});

	it('falls back to the dashboard when the context has no visible items', () => {
		expect(resolveSwitchTarget('marketing', undefined, [])).toBe('/dashboard');
	});
});

describe('readLastVisitedRoutes', () => {
	it('keeps the string route of each context it knows', () => {
		expect(
			readLastVisitedRoutes({ inbox: '/dashboard/inbox', marketing: '/dashboard/campaigns' })
		).toEqual({ inbox: '/dashboard/inbox', marketing: '/dashboard/campaigns' });
	});

	it('drops an unknown context and a route that is not a string', () => {
		expect(
			readLastVisitedRoutes({ inbox: 7, marketing: '/dashboard/campaigns', chat: '/x' })
		).toEqual({ marketing: '/dashboard/campaigns' });
	});

	it('does not accept a stored value that is not an object', () => {
		for (const stored of [null, ['/dashboard/inbox'], '/dashboard/inbox', 1]) {
			expect(readLastVisitedRoutes(stored)).toBeUndefined();
		}
	});
});

describe('sendingZones', () => {
	const env = (role: OrganizationRole | null, flags: readonly FeatureFlagKey[]) => ({
		isFeatureEnabled: (flag: FeatureFlagKey) => flags.includes(flag),
		isDesktop: false,
		role,
	});

	it('labels both zones when an admin sees marketing and transactional', () => {
		expect(sendingZones(env('admin', ['campaigns', 'transactional']))).toEqual({
			marketing: true,
			transactional: true,
			labelled: true,
		});
	});

	it('keeps the Marketing zone for automations alone', () => {
		expect(sendingZones(env('owner', ['automations', 'transactional']))).toEqual({
			marketing: true,
			transactional: true,
			labelled: true,
		});
	});

	it('drops the labels when campaigns and automations are off', () => {
		expect(sendingZones(env('admin', ['transactional']))).toEqual({
			marketing: false,
			transactional: true,
			labelled: false,
		});
	});

	it('drops the labels when transactional is off', () => {
		expect(sendingZones(env('admin', ['campaigns', 'automations']))).toEqual({
			marketing: true,
			transactional: false,
			labelled: false,
		});
	});

	it('shows an editor only the Marketing zone, unlabelled', () => {
		expect(sendingZones(env('editor', ['campaigns', 'automations', 'transactional']))).toEqual({
			marketing: true,
			transactional: false,
			labelled: false,
		});
	});

	it('shows neither zone to an editor without campaigns', () => {
		expect(sendingZones(env('editor', ['automations', 'transactional']))).toEqual({
			marketing: false,
			transactional: false,
			labelled: false,
		});
	});
});
