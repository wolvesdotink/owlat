/**
 * Pure-logic coverage for the sidebar Inbox ↔ Marketing context model:
 *   - route ownership: which context owns a path, shared routes → null
 *   - section partitioning: context blocks + shared block, order preserved
 *   - switch-target resolution: last-visited > preferred home > first item
 */
import { describe, it, expect } from 'vitest';
import type { SectionKey } from '~/composables/useSidebarState';
import { contextForPath, resolveSwitchTarget, splitSectionsByContext } from '../sidebarContext';

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
		expect(contextForPath('/dashboard/delivery/setup')).toBe('marketing');
	});

	it('returns null for shared routes', () => {
		expect(contextForPath('/dashboard')).toBeNull();
		expect(contextForPath('/dashboard/assistant')).toBeNull();
		expect(contextForPath('/dashboard/knowledge/graph')).toBeNull();
		expect(contextForPath('/dashboard/settings/features')).toBeNull();
	});

	it('matches whole path segments only', () => {
		expect(contextForPath('/dashboard/inboxes')).toBeNull();
		expect(contextForPath('/dashboard/sendgrid')).toBeNull();
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
			section('audience', ['/dashboard/audience']),
			section('delivery', ['/dashboard/delivery']),
			section('knowledge', ['/dashboard/knowledge']),
			section('settings', ['/dashboard/settings']),
		]);
		expect(split.inbox.map((s) => s.key)).toEqual(['inbox', 'postbox', 'chat']);
		expect(split.marketing.map((s) => s.key)).toEqual(['send', 'audience', 'delivery']);
		expect(split.shared.map((s) => s.key)).toEqual(['assistant', 'knowledge', 'settings']);
	});

	it('yields an empty context when its sections were flag-filtered out', () => {
		const split = splitSectionsByContext([
			section('send', ['/dashboard/send']),
			section('settings', ['/dashboard/settings']),
		]);
		expect(split.inbox).toEqual([]);
		expect(split.marketing.map((s) => s.key)).toEqual(['send']);
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

	it('ignores a last-visited route the target context does not own', () => {
		expect(resolveSwitchTarget('inbox', '/dashboard/campaigns', sections)).toBe(
			'/dashboard/postbox/inbox'
		);
	});

	it('falls back to the preferred home when its item is visible', () => {
		expect(resolveSwitchTarget('inbox', undefined, sections)).toBe('/dashboard/postbox/inbox');
		expect(resolveSwitchTarget('marketing', undefined, sections)).toBe('/dashboard/campaigns');
	});

	it('falls back to the first visible item when the preferred home was flag-filtered out', () => {
		const noPostbox = [
			section('inbox', ['/dashboard/inbox']),
			section('send', ['/dashboard/send']),
		];
		expect(resolveSwitchTarget('inbox', undefined, noPostbox)).toBe('/dashboard/inbox');
		expect(resolveSwitchTarget('marketing', undefined, noPostbox)).toBe('/dashboard/send');
	});

	it('falls back to the dashboard when the context has no visible items', () => {
		expect(resolveSwitchTarget('marketing', undefined, [])).toBe('/dashboard');
	});
});
