import { describe, expect, it } from 'vitest';
import { sidebarConfig, sidebarGroupsForSection } from '../app/utils/sidebarConfig';

describe('sidebarGroupsForSection', () => {
	const expectedSections: Record<string, string[]> = {
		guide: [
			'Getting Started',
			'Building Emails',
			'Your Audience',
			'Campaigns',
			'Transactional & Automations',
			'Personal Email (Postbox)',
			'Team Inbox',
			'Knowledge & Collaboration',
			'Operations',
		],
		api: ['Overview', 'Core Endpoints', 'Delivery & Public Endpoints'],
		developer: [
			'Architecture',
			'Email & Delivery',
			'Subsystem Internals',
			'Self-Hosting',
			'Decisions',
		],
		examples: ['Examples'],
		vision: ['Vision'],
	};

	for (const [section, groupLabels] of Object.entries(expectedSections)) {
		it(`yields the ${section} groups`, () => {
			const groups = sidebarGroupsForSection(section);
			expect(groups.map((group) => group.label)).toEqual(groupLabels);
			for (const group of groups) {
				expect(group.items.length).toBeGreaterThan(0);
			}
		});
	}

	it('yields nothing for unknown sections', () => {
		expect(sidebarGroupsForSection('nonexistent')).toEqual([]);
		expect(sidebarGroupsForSection('')).toEqual([]);
	});

	it('covers every configured section (no orphaned groups)', () => {
		const covered = new Set(Object.keys(expectedSections));
		for (const group of sidebarConfig) {
			expect(covered.has(group.section), `unexpected section "${group.section}"`).toBe(true);
		}
	});

	it('every item links into its own section', () => {
		for (const group of sidebarConfig) {
			for (const item of group.items) {
				expect(item.to.startsWith(`/${group.section}`)).toBe(true);
			}
		}
	});
});
