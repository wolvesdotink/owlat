/**
 * Split-inbox paging (idea 24). The one invariant worth a test: growing one
 * section's page leaves every other section's page exactly where it was, which
 * is what stops a chatty section from starving a quiet one.
 */
import { describe, it, expect } from 'vitest';
import {
	POSTBOX_SECTION_LIMIT_MAX,
	POSTBOX_SECTION_OTHER_KEY,
	POSTBOX_SECTION_PAGE,
	POSTBOX_SECTION_PAGE_STEP,
	growPostboxSection,
	isPostboxSectionAtMax,
	postboxSectionKey,
	postboxSectionLimit,
	postboxSectionLimitArgs,
} from '../postboxSections';

describe('postboxSectionKey', () => {
	it('maps the unnamed remainder onto the empty-string wire key', () => {
		expect(postboxSectionKey(null)).toBe(POSTBOX_SECTION_OTHER_KEY);
		expect(postboxSectionKey('Deploys')).toBe('Deploys');
	});
});

describe('postboxSectionLimit', () => {
	it('falls back to the shared default for a section never grown', () => {
		expect(postboxSectionLimit({}, 'Deploys')).toBe(POSTBOX_SECTION_PAGE);
	});
});

describe('growPostboxSection', () => {
	it('grows only the section asked for', () => {
		const before = { Team: POSTBOX_SECTION_PAGE, Deploys: POSTBOX_SECTION_PAGE };
		const after = growPostboxSection(before, 'Deploys');
		expect(after['Deploys']).toBe(POSTBOX_SECTION_PAGE + POSTBOX_SECTION_PAGE_STEP);
		expect(after['Team']).toBe(POSTBOX_SECTION_PAGE);
	});

	it('grows the remainder through its empty-string key', () => {
		const after = growPostboxSection({}, POSTBOX_SECTION_OTHER_KEY);
		expect(after[POSTBOX_SECTION_OTHER_KEY]).toBe(POSTBOX_SECTION_PAGE + POSTBOX_SECTION_PAGE_STEP);
	});

	it('stops at the ceiling instead of offering a page that cannot advance', () => {
		let limits: Record<string, number> = { Deploys: POSTBOX_SECTION_LIMIT_MAX - 1 };
		limits = growPostboxSection(limits, 'Deploys');
		expect(limits['Deploys']).toBe(POSTBOX_SECTION_LIMIT_MAX);
		expect(isPostboxSectionAtMax(limits, 'Deploys')).toBe(true);
		expect(isPostboxSectionAtMax(limits, 'Team')).toBe(false);
	});

	it('never mutates the record it was handed', () => {
		const before = Object.freeze({ Team: POSTBOX_SECTION_PAGE });
		growPostboxSection(before, 'Team');
		expect(before).toEqual({ Team: POSTBOX_SECTION_PAGE });
	});
});

describe('postboxSectionLimitArgs', () => {
	it('sends only the sections the user has actually grown', () => {
		expect(postboxSectionLimitArgs({})).toEqual([]);
		expect(postboxSectionLimitArgs({ Deploys: 40 })).toEqual([{ section: 'Deploys', limit: 40 }]);
	});
});
