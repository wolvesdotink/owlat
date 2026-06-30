/**
 * Block module: accordion.
 *
 * CSS-only `:checked` toggle (hidden `<input>` + `<label>` + sibling selectors).
 * Works in Apple Mail / iOS Mail (~40% of clients); other clients see every
 * section expanded as the fallback, which the `preflight` warning surfaces.
 *
 * Composite: recurses into each section's items via `args.walk` at the
 * `container` placement.
 */

import { fullSupport } from '@owlat/shared';
import { itemToBlock, type BlockModule, type Placement } from '../_module';
import { escapeHtml } from '../../sanitize';
import { checkShape, isString, isArray, isObject } from '../../helpers/validation';

export const accordionModule: BlockModule<'accordion'> = {
	type: 'accordion',
	placements: ['root'] as readonly Placement[],

	isEmpty(content) {
		return !content.sections || content.sections.length === 0;
	},

	preflight({ ctx }) {
		ctx.warnings.push('Accordion block uses CSS :checked selectors — only interactive in Apple Mail/iOS Mail (~40% of clients). Other clients show all sections expanded.');
	},

	html({ content, ctx, walk }) {
		const headerBg = content.headerBackgroundColor || '#f5f5f5';
		const headerColor = content.headerTextColor || '#333333';
		const headerFontSize = content.headerFontSize || 16;
		const contentBg = content.contentBackgroundColor || '#ffffff';
		const iconColor = content.iconColor || '#666666';
		const sectionBorder = content.sectionBorderColor || '#e0e0e0';
		const borderRadius = content.borderRadius || 0;

		const sections = content.sections.map((section, idx) => {
			const isInitiallyExpanded = content.initialExpanded === idx;
			const inputType = content.allowMultiple ? 'checkbox' : 'radio';
			const inputName = content.allowMultiple ? `owlat-acc-${section.id}` : 'owlat-accordion';
			const checkedAttr = isInitiallyExpanded ? ' checked' : '';

			const childHtml = section.items
				.map((item) => walk(itemToBlock(item), ctx.baseWidth, 'container'))
				.filter(Boolean)
				.join('');

			return `<div style="border-bottom:1px solid ${sectionBorder}">` +
				`<input type="${inputType}" name="${inputName}" id="owlat-acc-${section.id}" style="position:absolute;left:-9999px;opacity:0;mso-hide:all"${checkedAttr} />` +
				`<label for="owlat-acc-${section.id}" style="display:block;padding:12px 16px;background-color:${headerBg};color:${headerColor};font-size:${headerFontSize}px;font-family:${ctx.theme.fontFamily};cursor:pointer;user-select:none">` +
				`<span style="display:inline-block;float:right;color:${iconColor};font-size:20px;line-height:${headerFontSize}px">&#9660;</span>` +
				`${escapeHtml(section.title)}</label>` +
				`<div class="owlat-acc-content" style="background-color:${contentBg};padding:16px">` +
				childHtml +
				`</div></div>`;
		}).join('');

		const style = `<style>` +
			`.owlat-acc-content{max-height:0;overflow:hidden;padding:0 16px!important}` +
			`input[id^="owlat-acc-"]:checked+label span{transform:rotate(180deg)}` +
			`input[id^="owlat-acc-"]:checked+label+.owlat-acc-content{max-height:none!important;padding:16px!important}` +
			`.moz-text-html input[id^="owlat-acc-"]{display:block!important;overflow:hidden!important;height:0!important;border:none!important}` +
			`</style>`;

		const radiusCss = borderRadius > 0 ? `border-radius:${borderRadius}px;overflow:hidden;` : '';

		return `${style}<table width="100%" cellpadding="0" cellspacing="0" border="0" role="presentation"><tr><td><div style="border:1px solid ${sectionBorder};${radiusCss}">${sections}</div></td></tr></table>`;
	},

	plaintext({ content, walk }) {
		return content.sections.map((section) => {
			const childParts: string[] = [];
			for (const item of section.items) {
				const text = walk(itemToBlock(item));
				if (text) childParts.push(text);
			}
			return `== ${section.title} ==\n${childParts.join('\n')}`;
		}).join('\n\n');
	},

	amp({ content, walk }) {
		const sections = content.sections.map((s) => {
			const itemsHtml = s.items.map((item) =>
				walk(itemToBlock(item))
			).join('\n');
			return `<section>
<h3>${escapeHtml(s.title)}</h3>
<div>${itemsHtml}</div>
</section>`;
		}).join('\n');
		return `<amp-accordion>${sections}</amp-accordion>`;
	},

	createDefault() {
		return {
			sections: [
				{ id: 'sec-1', title: 'Section 1', items: [] },
				{ id: 'sec-2', title: 'Section 2', items: [] },
			],
			allowMultiple: false,
			initialExpanded: 0,
			headerBackgroundColor: '#f5f5f5',
			headerTextColor: '#333333',
			headerFontSize: 16,
			contentBackgroundColor: '#ffffff',
			iconColor: '#666666',
			sectionBorderColor: '#e0e0e0',
		};
	},

	compatibility: {
		features: [
			{
				feature: 'CSS-only toggle',
				description: 'Expandable/collapsible sections using :checked selector',
				support: {
					...fullSupport,
					gmail: 'none',
					gmailApp: 'none',
					outlookDesktop: 'none',
					outlook365: 'none',
					yahooMail: 'none',
					samsungMail: 'partial',
				},
				fallback:
					'Falls back to all sections expanded in unsupported clients — content always visible',
				owlatHandled: true,
				canIEmailSlug: 'css-pseudo-class-checked',
			},
			{
				feature: 'allowMultiple',
				description: 'Multiple sections open simultaneously',
				support: {
					...fullSupport,
					gmail: 'none',
					gmailApp: 'none',
					outlookDesktop: 'none',
					outlook365: 'none',
					yahooMail: 'none',
				},
				fallback: 'All sections expanded in unsupported clients',
				owlatHandled: false,
			},
		],
		properties: [
			{
				property: 'allowMultiple',
				description: 'Multiple sections open simultaneously',
				support: {
					...fullSupport,
					gmail: 'none',
					gmailApp: 'none',
					outlookDesktop: 'none',
					outlook365: 'none',
					yahooMail: 'none',
				},
				severity: 'info',
				recommendation: 'Only affects clients where accordion is interactive (~40%)',
				owlatHandled: false,
			},
			{
				property: 'initialExpanded',
				description: 'Initially expanded section index',
				support: {
					...fullSupport,
					gmail: 'none',
					gmailApp: 'none',
					outlookDesktop: 'none',
					outlook365: 'none',
					yahooMail: 'none',
				},
				severity: 'info',
				recommendation:
					'All sections expanded in fallback clients — content is always visible',
				owlatHandled: true,
			},
		],
	},

	validate({ block, content, ctx }) {
		const ic = content as unknown as Record<string, unknown>;

		// Shape
		checkShape(ic, [
			{ field: 'sections', check: isArray, code: 'ACCORDION_SECTIONS_TYPE', message: 'sections must be an array' },
		], block.id, 'accordion', ctx.issues);

		if (isArray(ic['sections'])) {
			for (let i = 0; i < (ic['sections'] as unknown[]).length; i++) {
				const section = (ic['sections'] as unknown[])[i];
				if (!isObject(section) || !isString(section['id']) || !isString(section['title']) || !isArray(section['items'])) {
					ctx.issues.push({ blockId: block.id, blockType: 'accordion', severity: 'error', code: 'ACCORDION_SECTION_SHAPE', message: `section ${i} must have id, title, and items` });
				}
			}
		}

		// Semantic: Gmail strips form elements
		ctx.issues.push({ blockId: block.id, blockType: 'accordion', severity: 'info', code: 'GMAIL_FORM_ELEMENTS', message: 'Accordion uses :checked CSS pattern with form elements — Gmail strips these, so accordion will show all sections expanded in Gmail' });

		// Recurse into section items
		for (const section of content.sections) {
			for (const item of section.items) {
				ctx.recurse(itemToBlock(item), ctx.depth + 1);
			}
		}
	},
};
