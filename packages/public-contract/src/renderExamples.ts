/**
 * The examples of the render operation and of the send's dry run, spread into
 * `OPERATION_EXAMPLES` (`./examples.ts`), which says what every example must
 * hold.
 */

import type { OperationExample } from './examples';
import type {
	ApiResponse,
	EmailHealth,
	RenderRequest,
	RenderResult,
	SendTransactionalDryRun,
	SendTransactionalRequest,
} from './types';

const HTML =
	'<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><title>Your order A-1001</title></head><body style="margin:0;padding:0;background-color:#f4f4f5"><div style="display:none">Arriving Thursday</div><h1>Thanks for your order, Ada</h1></body></html>';

const HEALTH: EmailHealth = {
	overall: 93,
	compatibility: 100,
	accessibility: 90,
	deliverability: 85,
	outlookSupport: 100,
	recommendations: [
		{
			category: 'accessibility',
			message: '1 accessibility warning(s) — improve link text and heading hierarchy',
			impact: 'medium',
		},
	],
	analysis: {
		htmlSizeBytes: 251,
		exceedsGmailClip: false,
		exceedsGmailCssLimit: false,
		styleBlockSizeBytes: 0,
		tableNestingDepth: 0,
		imageCount: 0,
		linkCount: 0,
		hasTextContent: false,
		textToImageRatio: null,
		displayNoneCount: 0,
		warnings: [],
	},
};

const RENDER_REQUEST: RenderRequest = {
	kind: 'transactional',
	subject: 'Your order {{orderNumber}}',
	previewText: 'Arriving {{deliveryDay}}',
	blocks: [
		{
			id: 'b-heading',
			type: 'text',
			content: { html: '<h1>Thanks for your order, {{firstName}}</h1>' },
		},
	],
	translations: {
		de: {
			subject: 'Deine Bestellung {{orderNumber}}',
			blocks: { 'b-heading': { html: '<h1>Danke für deine Bestellung, {{firstName}}</h1>' } },
		},
	},
	defaultLanguage: 'en',
	language: 'en',
	dataVariablesSchema: { orderNumber: 'string', firstName: 'string', deliveryDay: 'string' },
	dataVariables: { orderNumber: 'A-1001', firstName: 'Ada', deliveryDay: 'Thursday' },
	darkMode: true,
};

/** The answer to the `dryRunTransactional` example request. */
const DRY_RUN_RESPONSE = {
	data: {
		status: 'dry_run',
		dryRun: true,
		wouldQueue: false,
		refusal: {
			status: 400,
			category: 'invalid_input',
			message:
				'Missing data variable "firstName": the email uses it without a fallback. Supply it, or mark it optional in the template\'s variables to send it empty.',
			data: { reason: 'invalid_variables', field: 'dataVariables', variables: ['firstName'] },
			retryAfter: null,
		},
		email: 'ada@example.com',
		templateId: 'k57t3mpl4te0000000000000000000',
		slug: 'order-confirmation',
		templateStatus: 'published',
		contactId: null,
		language: 'en',
		subject: 'Your order A-1001',
		html: HTML.replace('Ada', ''),
		text: 'Thanks for your order,',
		unsubscribeFooter: false,
		missingVariables: ['firstName'],
	},
} satisfies ApiResponse<SendTransactionalDryRun>;

export const RENDER_EXAMPLES = {
	renderEmail: {
		request: RENDER_REQUEST,
		response: {
			data: {
				kind: 'transactional',
				language: 'en',
				composed: true,
				subject: 'Your order A-1001',
				html: HTML,
				text: 'Thanks for your order, Ada',
				darkHtml: HTML,
				issues: [
					{
						severity: 'warning',
						code: 'A11Y_HEADING_ORDER',
						message: 'The email starts with a heading below level 1',
						blockId: 'b-heading',
						blockType: 'text',
					},
				],
				missingVariables: [],
				sendRefusal: null,
				health: HEALTH,
			},
		} satisfies ApiResponse<RenderResult>,
	},
	dryRunTransactional: {
		request: {
			email: 'ada@example.com',
			slug: 'order-confirmation',
			dataVariables: { orderNumber: 'A-1001' },
			language: 'en',
		} satisfies SendTransactionalRequest,
		response: DRY_RUN_RESPONSE,
	},
} satisfies Record<string, OperationExample>;
