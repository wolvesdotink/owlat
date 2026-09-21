import { describe, it, expect, vi } from 'vitest';
import { renderDraftBodies } from '../draftBodies';

/**
 * The shared derivation behind BOTH the outbound dispatch action and the
 * composer's "Preview as sent" (plan idea 14). The point of these tests is that
 * the plain-text alternative the sender is shown is the one that ships — so
 * they assert on `text` at least as hard as on `html`.
 */
describe('renderDraftBodies', () => {
	const simpleDraft = {
		composerMode: 'simple',
		bodyHtml: '<p>Hi Ines,</p><p>The invoice is attached.</p>',
		subject: 'Invoice 4471',
	};

	it('wraps simple-mode HTML into a full document and derives its plain text', () => {
		const bodies = renderDraftBodies(simpleDraft);
		expect(bodies.html).toContain('The invoice is attached.');
		expect(bodies.html.toLowerCase()).toContain('<html');
		expect(bodies.text).toContain('Hi Ines,');
		expect(bodies.text).toContain('The invoice is attached.');
		// Plain text is plain: no tags survive into the text/plain alternative.
		expect(bodies.text).not.toMatch(/<[a-z]/i);
		// Simple mode has no interactive blocks, so it never ships an AMP part.
		expect(bodies.amp).toBeUndefined();
	});

	it('honours an author-written text/plain override', () => {
		const bodies = renderDraftBodies({ ...simpleDraft, bodyText: 'See the attached invoice.' });
		expect(bodies.text).toBe('See the attached invoice.');
	});

	it('renders the dark variant from the same source', () => {
		const light = renderDraftBodies(simpleDraft);
		const dark = renderDraftBodies(simpleDraft, { darkMode: true });
		expect(dark.html).not.toBe(light.html);
		// The text/plain alternative has no colours to invert — a dark preview
		// must not imply the recipient gets different words.
		expect(dark.text).toBe(light.text);
	});

	it('renders a block design and gives interactive blocks an AMP part', () => {
		const blocks = [
			{
				id: 'a',
				type: 'text',
				content: { html: '<p>Quarterly numbers</p>', blockType: 'paragraph', fontSize: 16 },
			},
			{
				id: 'b',
				type: 'accordion',
				content: { sections: [{ id: 's1', title: 'Detail', items: [] }] },
			},
		];
		const bodies = renderDraftBodies({
			composerMode: 'full',
			bodyBlocks: JSON.stringify(blocks),
			subject: 'Q3',
		});
		expect(bodies.html).toContain('Quarterly numbers');
		expect(bodies.text).toContain('Quarterly numbers');
		expect(bodies.amp).toBeTruthy();
	});

	it('omits the AMP part for a block design with nothing interactive in it', () => {
		const bodies = renderDraftBodies({
			composerMode: 'full',
			bodyBlocks: JSON.stringify([
				{ id: 'a', type: 'text', content: { html: '<p>Plain</p>', blockType: 'paragraph' } },
			]),
		});
		expect(bodies.amp).toBeUndefined();
	});

	it('falls back to bodyHtml and reports when the blocks will not parse', () => {
		const onBlockParseError = vi.fn();
		const bodies = renderDraftBodies(
			{ composerMode: 'full', bodyBlocks: '{not json', bodyHtml: '<p>Fallback body</p>' },
			{ onBlockParseError }
		);
		expect(onBlockParseError).toHaveBeenCalledOnce();
		expect(bodies.html).toContain('Fallback body');
		expect(bodies.text).toContain('Fallback body');
	});

	it('treats an empty designer as simple mode rather than rendering nothing', () => {
		const bodies = renderDraftBodies({
			composerMode: 'full',
			bodyBlocks: '[]',
			bodyHtml: '<p>Typed before switching modes</p>',
		});
		expect(bodies.text).toContain('Typed before switching modes');
	});

	it('survives a draft with no body at all', () => {
		const bodies = renderDraftBodies({});
		expect(typeof bodies.html).toBe('string');
		expect(typeof bodies.text).toBe('string');
	});
});
