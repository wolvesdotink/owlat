import { describe, expect, it } from 'vitest';
import type { EditorBlock } from '@owlat/shared';
import { resolveBrandKitDesign } from '@owlat/shared/brandKit';
import {
	brandDraftBlocks,
	draftLanguage,
	draftSlug,
	inlineHtml,
	planDraft,
	PLACEHOLDER_URL,
	safeUrl,
	type GenerationKind,
} from '../blocksDecision';
import { GENERATION_LIMITS, type GeneratedEmail, type GeneratedSection } from '../outputSchema';

const section = (
	over: Partial<GeneratedSection> & Pick<GeneratedSection, 'kind'>
): GeneratedSection => ({
	text: null,
	level: null,
	url: null,
	items: null,
	ordered: null,
	...over,
});

const email = (over: Partial<GeneratedEmail> = {}): GeneratedEmail => ({
	name: 'Booking confirmation',
	subject: 'Your booking is confirmed',
	previewText: 'See you soon',
	language: 'en',
	slug: null,
	sections: [
		section({ kind: 'heading', level: 'h1', text: 'You are booked' }),
		section({ kind: 'paragraph', text: 'Thanks for booking.' }),
	],
	variables: [],
	...over,
});

function ids() {
	let n = 0;
	return () => `block-${++n}`;
}

function plan(e: GeneratedEmail, kind: GenerationKind = 'template') {
	const result = planDraft(e, { kind, fallbackLanguage: 'en', newId: ids() });
	if (!result.ok) throw new Error(`unexpected refusal: ${result.reason}`);
	return result.plan;
}

const content = (block: EditorBlock | undefined) =>
	block?.content as unknown as Record<string, unknown>;

describe('planDraft: sections to blocks', () => {
	it('maps every section kind to its block with the renderer defaults', () => {
		const { blocks } = plan(
			email({
				sections: [
					section({ kind: 'heading', level: 'h1', text: 'Title' }),
					section({ kind: 'heading', level: 'h3', text: 'Sub' }),
					section({ kind: 'paragraph', text: 'First.\n\nSecond line' }),
					section({ kind: 'button', text: 'Open', url: 'https://owlat.app/pricing' }),
					section({ kind: 'list', items: ['One', 'Two'], ordered: true }),
					section({ kind: 'list', items: ['Dot'], ordered: false }),
					section({ kind: 'divider' }),
					section({ kind: 'spacer' }),
				],
			})
		);
		expect(blocks.map((b) => b.type)).toEqual([
			'text',
			'text',
			'text',
			'button',
			'list',
			'list',
			'divider',
			'spacer',
		]);
		expect(content(blocks[0])).toMatchObject({
			html: '<h1>Title</h1>',
			blockType: 'h1',
			fontSize: 28,
		});
		expect(content(blocks[1])).toMatchObject({ html: '<h3>Sub</h3>', blockType: 'h3' });
		expect(content(blocks[2])).toMatchObject({
			html: '<p>First.</p><p>Second line</p>',
			blockType: 'paragraph',
			textColor: '#374151',
			paddingTop: 16,
		});
		expect(content(blocks[3])).toMatchObject({
			text: 'Open',
			url: 'https://owlat.app/pricing',
			align: 'center',
			borderRadius: 8,
		});
		expect(content(blocks[4])).toMatchObject({ items: ['One', 'Two'], listType: 'numbered' });
		expect(content(blocks[5])).toMatchObject({ listType: 'bullet' });
		expect(content(blocks[7])).toEqual({ height: 24 });
	});

	it('gives every block a fresh, unique id', () => {
		const { blocks } = plan(
			email({
				sections: Array.from({ length: 6 }, () => section({ kind: 'paragraph', text: 'x' })),
			})
		);
		expect(new Set(blocks.map((b) => b.id)).size).toBe(6);
	});

	it('caps the section count, list items and text sizes', () => {
		const long = 'a'.repeat(GENERATION_LIMITS.paragraphChars + 500);
		const { blocks, droppedSections } = plan(
			email({
				subject: 's'.repeat(500),
				sections: [
					section({ kind: 'paragraph', text: long }),
					section({ kind: 'list', items: Array.from({ length: 30 }, (_, i) => `item ${i}`) }),
					...Array.from({ length: 60 }, () => section({ kind: 'divider' })),
				],
			})
		);
		expect(blocks).toHaveLength(GENERATION_LIMITS.sections);
		expect(droppedSections).toBe(62 - GENERATION_LIMITS.sections);
		const html = content(blocks[0])!['html'] as string;
		expect(html.length).toBeLessThanOrEqual(GENERATION_LIMITS.paragraphChars + '<p></p>'.length);
		expect(content(blocks[1])!['items']).toHaveLength(GENERATION_LIMITS.listItems);
		expect(plan(email({ subject: 's'.repeat(500) })).subject.length).toBe(
			GENERATION_LIMITS.subjectChars
		);
	});

	it('leaves out empty sections and refuses an email with no text', () => {
		const result = planDraft(
			email({ sections: [section({ kind: 'heading', text: '  ' }), section({ kind: 'divider' })] }),
			{ kind: 'template', fallbackLanguage: 'en', newId: ids() }
		);
		expect(result).toEqual({ ok: false, reason: 'no_content' });
		expect(
			planDraft(email({ subject: ' ' }), { kind: 'template', fallbackLanguage: 'en', newId: ids() })
		).toEqual({ ok: false, reason: 'no_subject' });
	});

	it('keeps a button with no usable link as the editor blank', () => {
		const { blocks } = plan(
			email({
				sections: [
					section({ kind: 'paragraph', text: 'Hi' }),
					section({ kind: 'button', text: 'Go', url: 'javascript:alert(1)' }),
					section({ kind: 'button', text: 'Go', url: null }),
				],
			})
		);
		expect(content(blocks[1])!['url']).toBe(PLACEHOLDER_URL);
		expect(content(blocks[2])!['url']).toBe(PLACEHOLDER_URL);
	});
});

describe('inline formatting', () => {
	it('escapes HTML and keeps only bold, italic and safe links', () => {
		expect(inlineHtml('<script>x</script> **bold** and *it*')).toBe(
			'&lt;script&gt;x&lt;/script&gt; <strong>bold</strong> and <em>it</em>'
		);
		expect(inlineHtml('[Pricing](https://owlat.app/p?a=1&b=2)')).toBe(
			'<a href="https://owlat.app/p?a=1&amp;b=2">Pricing</a>'
		);
		expect(inlineHtml('[bad](javascript:alert(1))')).toBe('bad)');
		expect(inlineHtml('line one\nline two')).toBe('line one<br>line two');
	});

	it('keeps a merge tag and its quoted fallback intact', () => {
		expect(inlineHtml("Hi {{firstName|'there'}}, <b>")).toBe("Hi {{firstName|'there'}}, &lt;b&gt;");
	});

	it('accepts http(s), mailto and a lone variable as link targets', () => {
		expect(safeUrl('https://owlat.app')).toBe('https://owlat.app');
		expect(safeUrl('mailto:hello@owlat.app')).toBe('mailto:hello@owlat.app');
		expect(safeUrl('{{rescheduleUrl}}')).toBe('{{rescheduleUrl}}');
		expect(safeUrl('data:text/html,x')).toBeNull();
		expect(safeUrl('https://a b')).toBeNull();
	});
});

describe('merge tags and data variables', () => {
	it('keeps only the marketing tags a send fills, with fallbacks for the rest', () => {
		const result = plan(
			email({
				sections: [
					section({
						kind: 'paragraph',
						text: "Hi {{firstName|'there'}}, your code {{coupon|'SAVE10'}} {{plan}}",
					}),
				],
				variables: [{ name: 'coupon', type: 'string', optional: false }],
			})
		);
		expect(content(result.blocks[0])!['html']).toBe(
			"<p>Hi {{firstName|'there'}}, your code SAVE10</p>"
		);
		expect(result.droppedVariables).toEqual(['coupon', 'plan']);
		expect(result.dataVariablesSchema).toBeNull();
	});

	it('declares exactly the transactional variables the content uses', () => {
		const result = plan(
			email({
				subject: 'Booking on {{meetingDate}}',
				sections: [
					section({ kind: 'paragraph', text: 'Hi {{name}}, see you at {{meetingTime}}.' }),
					section({ kind: 'button', text: 'Reschedule', url: '{{rescheduleUrl}}' }),
					section({ kind: 'paragraph', text: 'Ref {{undeclared}} {{bad-name}}' }),
				],
				variables: [
					{ name: 'name', type: 'string', optional: true },
					{ name: 'meetingDate', type: 'date', optional: false },
					{ name: 'meetingTime', type: 'string', optional: false },
					{ name: 'rescheduleUrl', type: 'string', optional: false },
					{ name: 'neverUsed', type: 'number', optional: false },
					{ name: 'bad name', type: 'string', optional: false },
				],
			}),
			'transactional'
		);
		expect(result.dataVariablesSchema).toEqual({
			name: 'string',
			meetingDate: 'date',
			meetingTime: 'string',
			rescheduleUrl: 'string',
		});
		expect(result.optionalDataVariables).toEqual(['name']);
		expect(result.droppedVariables).toEqual(['undeclared']);
		expect(content(result.blocks[1])!['url']).toBe('{{rescheduleUrl}}');
		expect(content(result.blocks[2])!['html']).toBe('<p>Ref {{bad-name}}</p>');
		expect(result.slug).toBe('booking-confirmation');
	});
});

describe('language and slug', () => {
	it('uses the model language when it is a code, else the fallback', () => {
		expect(draftLanguage('de', 'en')).toBe('de');
		expect(draftLanguage('DE-at', 'en')).toBe('de');
		expect(draftLanguage('German', 'fr')).toBe('fr');
		expect(draftLanguage('?', 'fr')).toBe('fr');
	});

	it('derives a slug in the API format', () => {
		expect(draftSlug('Booking Confirmation!', 'x')).toBe('booking-confirmation');
		expect(draftSlug(null, 'Order shipped')).toBe('order-shipped');
		expect(draftSlug(null, '!!!')).toBe('generated-email');
	});
});

describe('brandDraftBlocks', () => {
	const blocks: EditorBlock[] = [
		{
			id: 'b1',
			type: 'button',
			content: {
				text: 'Go',
				url: 'https://owlat.app',
				backgroundColor: '#000000',
				textColor: '#ffffff',
				align: 'center',
				borderRadius: 8,
				paddingX: 24,
				paddingY: 12,
			},
		},
	];

	it('returns the blocks unchanged without a configured kit', () => {
		const design = resolveBrandKitDesign(undefined, undefined);
		expect(
			brandDraftBlocks(blocks, { design, logos: { light: null, dark: null } }, 'template', ids())
		).toBe(blocks);
	});

	it('adds the kit footer and restyles the blocks', () => {
		const design = resolveBrandKitDesign(
			{ primaryColor: '#123456' },
			{ footerCompanyName: 'Owlat', footerAddress: 'Main street 1' }
		);
		const result = brandDraftBlocks(
			blocks,
			{ design, logos: { light: null, dark: null } },
			'transactional',
			ids()
		);
		expect(result.map((b) => b.type)).toEqual(['button', 'text']);
		expect(content(result[0])!['backgroundColor']).toBe('#123456');
		expect(content(result[1])!['html']).toContain('Owlat');
	});
});
