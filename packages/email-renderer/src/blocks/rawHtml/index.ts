/**
 * Block module: rawHtml.
 *
 * Escape hatch for hand-written HTML. Content is sanitised (`<script>`,
 * `<iframe>`, event handlers stripped) but otherwise passed through. Only
 * supported at root placement — nesting raw HTML inside columns/containers
 * is asking for malformed email output.
 */

import { fullSupport } from '@owlat/shared';
import type { BlockModule, Placement } from '../_module';
import { sanitizeRawHtml } from '../../sanitize';
import { stripHtml } from '../../helpers/text';
import { checkShape, isString } from '../../helpers/validation';

export const rawHtmlModule: BlockModule<'rawHtml'> = {
	type: 'rawHtml',
	placements: ['root'] as readonly Placement[],

	html({ content }) {
		return sanitizeRawHtml(content.html || '');
	},

	plaintext({ content }) {
		return stripHtml(content.html || '');
	},

	/** rawHtml has no AMP equivalent — AMP forbids arbitrary HTML. */

	createDefault() {
		return { html: '<!-- Your custom HTML here -->' };
	},

	compatibility: {
		features: [
			{
				feature: 'Custom HTML',
				description: 'Raw HTML injection',
				support: {
					...fullSupport,
					gmail: 'partial',
					gmailApp: 'partial',
					outlookDesktop: 'partial',
					yahooMail: 'partial',
				},
				fallback: 'Email clients may strip certain CSS and HTML tags',
				owlatHandled: false,
			},
		],
	},

	validate({ block, content, ctx }) {
		// Shape
		checkShape(content as unknown as Record<string, unknown>, [
			{ field: 'html', check: isString, code: 'RAWHTML_HTML_TYPE', message: 'html must be a string' },
		], block.id, 'rawHtml', ctx.issues);

		// Semantic: warn about dangerous patterns (sanitizer strips them, but the user should know)
		if (typeof content.html === 'string') {
			const html = content.html;
			if (/<script[\s>]/i.test(html)) {
				ctx.issues.push({ blockId: block.id, blockType: 'rawHtml', severity: 'warning', code: 'RAWHTML_SCRIPT_TAG', message: 'HTML contains <script> tags which will be stripped during rendering' });
			}
			if (/\bon\w+\s*=/i.test(html)) {
				ctx.issues.push({ blockId: block.id, blockType: 'rawHtml', severity: 'warning', code: 'RAWHTML_INLINE_HANDLERS', message: 'HTML contains inline event handlers (onclick, onload, etc.) which will be stripped during rendering' });
			}
			if (/<iframe[\s>]/i.test(html)) {
				ctx.issues.push({ blockId: block.id, blockType: 'rawHtml', severity: 'warning', code: 'RAWHTML_IFRAME', message: 'HTML contains <iframe> tags which may not be supported by all email clients' });
			}
		}
	},
};
