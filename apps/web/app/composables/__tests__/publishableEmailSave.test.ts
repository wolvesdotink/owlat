import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the renderer composable. `vi.hoisted` makes the spies exist before the
// hoisted `vi.mock` factory references them.
const { renderBlocksToHtml, buildHtmlTranslationsForEmail } = vi.hoisted(() => ({
	renderBlocksToHtml: vi.fn(),
	buildHtmlTranslationsForEmail: vi.fn(),
}));

vi.mock('../useEmailHtmlRendering', () => ({
	useEmailHtmlRendering: () => ({ renderBlocksToHtml, buildHtmlTranslationsForEmail }),
}));

import { publishableEmailSave } from '../publishableEmailSave';
import type { EditorBlock } from '@owlat/email-builder';
import type { EmailIdentifier, RenderOptions } from '../useEmailHtmlRendering';

const block = (id: string, savedBlockId?: string): EditorBlock =>
	({
		id,
		type: 'text',
		content: {},
		...(savedBlockId ? { savedBlockRef: { blockId: savedBlockId } } : {}),
	}) as unknown as EditorBlock;

describe('publishableEmailSave', () => {
	beforeEach(() => {
		renderBlocksToHtml.mockReset().mockReturnValue('<html>rendered</html>');
		buildHtmlTranslationsForEmail
			.mockReset()
			.mockResolvedValue({ de: { htmlContent: '<de>', subject: 'Betreff' } });
	});

	it('derives de-duplicated linkedBlockIds and hands rendered fields to update', async () => {
		const blocks = [
			block('1', 'b1'),
			block('2', 'b1'), // duplicate saved-block reference
			block('3', 'b2'),
			block('4'), // no saved-block reference
		];
		const update = vi.fn().mockResolvedValue(undefined);
		const identifier: EmailIdentifier = {
			emailType: 'marketing',
			emailId: 'tmpl_1' as EmailIdentifier['emailId'],
		};
		const renderOptions: RenderOptions = {
			variableType: 'personalization',
			theme: { primaryColor: '#000', fontFamily: 'Arial', backgroundColor: '#fff' },
		};

		await publishableEmailSave({
			identifier,
			blocks,
			renderOptions,
			supportedLanguages: ['en', 'de'],
			defaultLanguage: 'en',
			update,
		});

		// Renders with the supplied options and builds translations for the email.
		expect(renderBlocksToHtml).toHaveBeenCalledWith(blocks, renderOptions);
		expect(buildHtmlTranslationsForEmail).toHaveBeenCalledWith(
			identifier,
			['en', 'de'],
			'en',
			renderOptions
		);

		// Update receives the rendered HTML, serialized translations, and deduped ids.
		expect(update).toHaveBeenCalledWith({
			htmlContent: '<html>rendered</html>',
			htmlTranslations: JSON.stringify({ de: { htmlContent: '<de>', subject: 'Betreff' } }),
			linkedBlockIds: ['b1', 'b2'],
		});
	});

	it('emits empty linkedBlockIds and {} translations when there are none', async () => {
		buildHtmlTranslationsForEmail.mockResolvedValue({});
		const update = vi.fn().mockResolvedValue(undefined);

		await publishableEmailSave({
			identifier: {
				emailType: 'transactional',
				emailId: 'e_1' as EmailIdentifier['emailId'],
			},
			blocks: [block('1')],
			renderOptions: { variableType: 'data' },
			supportedLanguages: [],
			defaultLanguage: 'en',
			update,
		});

		expect(update).toHaveBeenCalledWith({
			htmlContent: '<html>rendered</html>',
			htmlTranslations: '{}',
			linkedBlockIds: [],
		});
	});

	it('rebuilds translations from the now-current content after persisting (structural edit)', async () => {
		// First build merges onto the OLD persisted content; after the content is
		// saved the second build reflects the new structure — the corrected set
		// must be the final write.
		buildHtmlTranslationsForEmail
			.mockReset()
			.mockResolvedValueOnce({ de: { htmlContent: '<de-old>', subject: 'Betreff' } })
			.mockResolvedValueOnce({ de: { htmlContent: '<de-new>', subject: 'Betreff' } });
		const update = vi.fn().mockResolvedValue(undefined);

		await publishableEmailSave({
			identifier: { emailType: 'marketing', emailId: 'tmpl_1' as EmailIdentifier['emailId'] },
			blocks: [block('1')],
			renderOptions: { variableType: 'personalization' },
			supportedLanguages: ['en', 'de'],
			defaultLanguage: 'en',
			update,
		});

		// Two passes: persist content, then persist the corrected translations.
		expect(buildHtmlTranslationsForEmail).toHaveBeenCalledTimes(2);
		expect(update).toHaveBeenCalledTimes(2);
		expect(update).toHaveBeenLastCalledWith({
			htmlContent: '<html>rendered</html>',
			htmlTranslations: JSON.stringify({ de: { htmlContent: '<de-new>', subject: 'Betreff' } }),
			linkedBlockIds: [],
		});
	});
});
