import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the renderer composable. `vi.hoisted` makes the spies exist before the
// hoisted `vi.mock` factory references them. The HTML stand-in spells out each
// block's text so a test can see which structure and which language text a
// rendered document came from.
const { renderBlocksToHtml, renderBlocksToPlainText } = vi.hoisted(() => ({
	renderBlocksToHtml: vi.fn(),
	renderBlocksToPlainText: vi.fn(),
}));

vi.mock('../useEmailHtmlRendering', () => ({
	useEmailHtmlRendering: () => ({ renderBlocksToHtml, renderBlocksToPlainText }),
}));

import {
	publishableEmailSave,
	sameDefaultLanguage,
	type PublishableEmailBase,
	type PublishableEmailDraft,
	type PublishableEmailPayload,
} from '../publishableEmailSave';
import type { EditorBlock } from '@owlat/email-builder';
import type { RenderOptions } from '../useEmailHtmlRendering';

const text = (id: string, html: string, savedBlockId?: string): EditorBlock =>
	({
		id,
		type: 'text',
		content: { html },
		...(savedBlockId ? { savedBlockRef: { blockId: savedBlockId } } : {}),
	}) as unknown as EditorBlock;

const renderOptions: RenderOptions = {
	variableType: 'personalization',
	theme: { primaryColor: '#000', fontFamily: 'Arial', backgroundColor: '#fff' },
};

const draft = (overrides: Partial<PublishableEmailDraft> = {}): PublishableEmailDraft => ({
	name: 'Welcome',
	subject: 'Hello',
	blocks: [text('b1', 'Hi there')],
	plainTextOverride: '',
	...overrides,
});

const base = (overrides: Partial<PublishableEmailBase> = {}): PublishableEmailBase => ({
	supportedLanguages: [],
	defaultLanguage: 'en',
	translations: undefined,
	revision: 5,
	...overrides,
});

/** Run a save and return the one payload it committed. */
async function saveAndCapture(
	d: PublishableEmailDraft,
	b: PublishableEmailBase
): Promise<PublishableEmailPayload> {
	const commit = vi.fn().mockResolvedValue(6);
	// The revision the write stored is what the editor builds its next save on.
	await expect(publishableEmailSave({ draft: d, base: b, renderOptions, commit })).resolves.toBe(6);
	expect(commit).toHaveBeenCalledOnce();
	return commit.mock.calls[0]![0] as PublishableEmailPayload;
}

describe('publishableEmailSave', () => {
	beforeEach(() => {
		renderBlocksToHtml
			.mockReset()
			.mockImplementation((blocks: EditorBlock[]) =>
				blocks.map((b) => (b.content as { html?: string }).html ?? b.id).join('|')
			);
		renderBlocksToPlainText.mockReset().mockReturnValue('rendered text');
	});

	it('commits every representation in one payload, with the base revision', async () => {
		const blocks = [
			text('1', 'A', 'b1'),
			text('2', 'B', 'b1'), // duplicate saved-block reference
			text('3', 'C', 'b2'),
			text('4', 'D'), // no saved-block reference
		];

		const payload = await saveAndCapture(draft({ blocks }), base());

		expect(renderBlocksToHtml).toHaveBeenCalledWith(blocks, renderOptions);
		expect(payload).toEqual({
			name: 'Welcome',
			subject: 'Hello',
			content: JSON.stringify(blocks),
			htmlContent: 'A|B|C|D',
			htmlTranslations: '{}',
			linkedBlockIds: ['b1', 'b2'],
			plainTextContent: 'rendered text',
			plainTextOverride: '',
			expectedContentRevision: 5,
		});
	});

	it('renders each language by overlaying its text onto the draft structure, not the persisted one', async () => {
		// The draft adds block b2 and reorders; the German overlay was written
		// against the old single-block content and knows only b1.
		const blocks = [text('b2', 'New paragraph'), text('b1', 'Hi there')];
		const translations = JSON.stringify({
			de: { subject: 'Hallo', blocks: { b1: { html: 'Hallo zusammen' } } },
		});

		const payload = await saveAndCapture(
			draft({ blocks }),
			base({ supportedLanguages: ['en', 'de', 'fr'], translations })
		);

		expect(JSON.parse(payload.htmlTranslations)).toEqual({
			de: { htmlContent: 'New paragraph|Hallo zusammen', subject: 'Hallo' },
			// No overlay yet: the default content and subject, as getForLanguage does.
			fr: { htmlContent: 'New paragraph|Hi there', subject: 'Hello' },
		});
		expect(payload.htmlContent).toBe('New paragraph|Hi there');
	});

	it('overlays text nested in columns and containers', async () => {
		const blocks = [
			{
				id: 'cols',
				type: 'columns',
				content: { columns: [[text('c1', 'Left')], [text('c2', 'Right')]] },
			},
		] as unknown as EditorBlock[];
		renderBlocksToHtml.mockImplementation((rendered: EditorBlock[]) => JSON.stringify(rendered));
		const translations = JSON.stringify({
			de: { subject: 'Hallo', blocks: { c2: { html: 'Rechts' } } },
		});

		const payload = await saveAndCapture(
			draft({ blocks }),
			base({ supportedLanguages: ['en', 'de'], translations })
		);

		const de = JSON.parse(JSON.parse(payload.htmlTranslations).de.htmlContent);
		expect(de[0].content.columns[0][0].content.html).toBe('Left');
		expect(de[0].content.columns[1][0].content.html).toBe('Rechts');
	});

	it('writes exactly once, so a failed commit leaves nothing half-written', async () => {
		// The old save wrote twice (new blocks + stale translations, then fixed
		// translations); a failure of the second write left them mismatched.
		const commit = vi.fn().mockRejectedValue(new Error('Save failed'));
		const translations = JSON.stringify({ de: { subject: 'Hallo', blocks: {} } });

		await expect(
			publishableEmailSave({
				draft: draft(),
				base: base({ supportedLanguages: ['en', 'de'], translations }),
				renderOptions,
				commit,
			})
		).rejects.toThrow('Save failed');

		expect(commit).toHaveBeenCalledOnce();
		const payload = commit.mock.calls[0]![0] as PublishableEmailPayload;
		// Blocks, default HTML and translated HTML all come from the same draft.
		expect(payload.content).toBe(JSON.stringify([text('b1', 'Hi there')]));
		expect(payload.htmlContent).toBe('Hi there');
		expect(JSON.parse(payload.htmlTranslations).de.htmlContent).toBe('Hi there');
	});

	it('does not let edits made while the write is in flight leak into the payload', async () => {
		const blocks = [text('b1', 'Hi there')];
		const liveDraft = draft({ blocks });
		let finish: () => void = () => {};
		const commit = vi.fn(
			() =>
				new Promise<void>((resolve) => {
					finish = resolve;
				})
		);

		const pending = publishableEmailSave({
			draft: liveDraft,
			base: base({
				supportedLanguages: ['en', 'de'],
				translations: JSON.stringify({ de: { subject: 'Hallo', blocks: {} } }),
			}),
			renderOptions,
			commit,
		});

		// The payload is built before anything is awaited...
		expect(commit).toHaveBeenCalledOnce();
		// ...so the canvas mutating the shared block array in place afterwards
		// cannot reach it.
		(blocks[0]!.content as { html: string }).html = 'Typed during the save';
		blocks.push(text('b2', 'Added during the save'));
		liveDraft.subject = 'Changed subject';
		finish();
		await pending;

		const payload = commit.mock.calls[0]![0] as PublishableEmailPayload;
		expect(payload.subject).toBe('Hello');
		expect(payload.content).toBe(JSON.stringify([text('b1', 'Hi there')]));
		expect(payload.htmlContent).toBe('Hi there');
		expect(JSON.parse(payload.htmlTranslations).de.htmlContent).toBe('Hi there');
	});

	it('passes the author override to the plain-text renderer and persists it', async () => {
		renderBlocksToPlainText.mockReturnValue('My own words');
		const blocks = [text('1', 'A')];

		const payload = await saveAndCapture(
			draft({ blocks, plainTextOverride: 'My own words' }),
			base()
		);

		expect(renderBlocksToPlainText).toHaveBeenCalledWith(blocks, 'My own words');
		expect(payload).toMatchObject({
			plainTextContent: 'My own words',
			plainTextOverride: 'My own words',
		});
	});

	it('omits the revision check when the base carries no revision', async () => {
		const payload = await saveAndCapture(draft(), base({ revision: undefined }));
		expect(payload.expectedContentRevision).toBeUndefined();
	});
});

describe('sameDefaultLanguage', () => {
	it('keeps a draft only while the default language is unchanged', () => {
		expect(sameDefaultLanguage({ defaultLanguage: 'en' }, { defaultLanguage: 'en' })).toBe(true);
		expect(sameDefaultLanguage({}, { defaultLanguage: 'en' })).toBe(true);
		expect(sameDefaultLanguage({ defaultLanguage: 'en' }, { defaultLanguage: 'de' })).toBe(false);
	});
});
