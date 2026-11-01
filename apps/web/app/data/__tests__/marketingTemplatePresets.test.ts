// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { getPresetById, marketingTemplatePresets } from '../marketingTemplatePresets';

/**
 * The template library renders the presets in catalog order, blank canvas
 * first, and creates an email from the one `getPresetById` returns. A block id
 * names a block inside the email the preset seeds, so two blocks of one preset
 * must never share one.
 */
describe('marketingTemplatePresets', () => {
	it('lists the presets in the order the library shows them', () => {
		expect(marketingTemplatePresets.map((preset) => preset.id)).toEqual([
			'blank',
			'welcome',
			'newsletter',
			'announcement',
			'product-update',
			'plain-text',
		]);
	});

	it('finds a preset by id', () => {
		for (const preset of marketingTemplatePresets) {
			expect(getPresetById(preset.id)).toBe(preset);
		}
		expect(getPresetById('missing')).toBeUndefined();
	});

	it('gives every preset a picker title and description key', () => {
		for (const preset of marketingTemplatePresets) {
			expect(preset.name).toMatch(/^shared\.data\.marketingTemplatePresets\.\w+\.name$/);
			expect(preset.description).toMatch(
				/^shared\.data\.marketingTemplatePresets\.\w+\.description$/
			);
		}
	});

	it('keeps block ids unique within a preset', () => {
		for (const preset of marketingTemplatePresets) {
			const ids = preset.content.map((block) => block.id);
			expect(new Set(ids).size, preset.id).toBe(ids.length);
		}
	});
});
