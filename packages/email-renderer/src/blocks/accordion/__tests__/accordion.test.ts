import { describe, it, expect } from 'vitest';
import { accordionModule } from '../index';
import { renderContainerItem } from '../../index';
import type { AccordionBlockContent, ContainerItem } from '@owlat/shared';
import type { RenderArgs, RenderContext } from '../../_module';

// Mirror what the walker would do: short-circuit on empty, then dispatch html()
// with a real `walk` that recurses through the container path (matching the
// historical `renderContainerItem` call accordion used to make directly).
const renderAccordionContent = (content: AccordionBlockContent, ctx: RenderContext): string => {
	if (accordionModule.isEmpty?.(content)) return '';
	const args: RenderArgs<'accordion'> = {
		block: { id: 'a', type: 'accordion', content },
		content,
		ctx,
		width: 600,
		placement: 'root',
		walk: (child, childWidth) => renderContainerItem(child as ContainerItem, childWidth, ctx),
	};
	return accordionModule.html(args);
};

const createCtx = (overrides?: Partial<RenderContext>): RenderContext => ({
	theme: { primaryColor: '#c4785a', fontFamily: 'Arial, sans-serif', backgroundColor: '#ffffff' },
	darkMode: false,
	variableType: 'personalization',
	variableClass: 'personalization-variable',
	baseWidth: 600,
	preheaderText: '',
	title: '',
	breakpoint: 480,
	direction: 'ltr',
	fontUrls: [],
	customCss: '',
	variableValues: {},
	lang: 'en',
	responsiveRules: [],
	globalRules: [],
	warnings: [],
	...overrides,
});

const makeContent = (overrides?: Partial<AccordionBlockContent>): AccordionBlockContent => ({
	sections: [
		{
			id: 'sec1',
			title: 'Section One',
			items: [
				{ id: 't1', type: 'text', content: { html: '<p>Content A</p>', blockType: 'paragraph', fontSize: 14, textColor: '#000' } },
			],
		},
		{
			id: 'sec2',
			title: 'Section Two',
			items: [
				{ id: 't2', type: 'text', content: { html: '<p>Content B</p>', blockType: 'paragraph', fontSize: 14, textColor: '#000' } },
			],
		},
	],
	...overrides,
});

describe('renderAccordionContent', () => {
	it('renders sections with titles and nested content', () => {
		const html = renderAccordionContent(makeContent(), createCtx());
		expect(html).toContain('Section One');
		expect(html).toContain('Section Two');
		expect(html).toContain('Content A');
		expect(html).toContain('Content B');
	});

	it('uses owlat-acc-content class on content divs', () => {
		const html = renderAccordionContent(makeContent(), createCtx());
		expect(html).toContain('class="owlat-acc-content"');
	});

	it('hides content via CSS style block with max-height:0', () => {
		const html = renderAccordionContent(makeContent(), createCtx());
		expect(html).toContain('<style>');
		expect(html).toContain('.owlat-acc-content{max-height:0');
	});

	it('uses checkbox input when allowMultiple is true', () => {
		const html = renderAccordionContent(makeContent({ allowMultiple: true }), createCtx());
		expect(html).toContain('type="checkbox"');
		expect(html).not.toContain('type="radio"');
	});

	it('uses radio input when allowMultiple is false', () => {
		const html = renderAccordionContent(makeContent({ allowMultiple: false }), createCtx());
		expect(html).toContain('type="radio"');
	});

	it('sets checked attribute on initialExpanded section', () => {
		const html = renderAccordionContent(makeContent({ initialExpanded: 1 }), createCtx());
		expect(html).toContain('id="owlat-acc-sec2"');
		// The second input should have checked
		const inputs = html.match(/<input[^>]*>/g) || [];
		expect(inputs[0]).not.toContain('checked');
		expect(inputs[1]).toContain('checked');
	});

	it('returns empty string when no sections', () => {
		const html = renderAccordionContent(makeContent({ sections: [] }), createCtx());
		expect(html).toBe('');
	});

	it('applies custom header and content colors', () => {
		const html = renderAccordionContent(
			makeContent({ headerBackgroundColor: '#ff0000', headerTextColor: '#00ff00', contentBackgroundColor: '#0000ff' }),
			createCtx(),
		);
		expect(html).toContain('background-color:#ff0000');
		expect(html).toContain('color:#00ff00');
		expect(html).toContain('background-color:#0000ff');
	});

	it('applies border radius wrapper', () => {
		const html = renderAccordionContent(makeContent({ borderRadius: 12 }), createCtx());
		expect(html).toContain('border-radius:12px');
		expect(html).toContain('overflow:hidden');
	});
});
