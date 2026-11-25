/**
 * The operations of `/api/v1/brand-kit`, spliced into the table in
 * `./operations.ts`.
 */

import { brandKitSchema, brandKitUpdateRequestSchema } from './brandKit';
import { WRITE_REFUSAL_REASONS } from './types';
import type { PublicOperation } from './operationShape';

export const BRAND_KIT_OPERATIONS = [
	{
		operationId: 'getBrandKit',
		method: 'GET',
		path: '/api/v1/brand-kit',
		tag: 'Brand kit',
		summary:
			'Get the brand kit: the colours, fonts, button style, footer and logos every email starts from, as the brand kit page shows them.',
		scope: 'brand-kit:read',
		pathParameters: [],
		queryParameters: [],
		idempotent: false,
		request: null,
		success: {
			status: 200,
			description: 'The brand kit.',
			name: 'BrandKit',
			data: brandKitSchema,
			paginated: false,
		},
		errors: [],
		reasons: [],
	},
	{
		operationId: 'updateBrandKit',
		method: 'PUT',
		path: '/api/v1/brand-kit',
		tag: 'Brand kit',
		summary:
			'Change the brand kit. Send only the fields to change: a field left out keeps its stored value, and the answer is the whole kit after the write. The values are checked as on the brand kit page, and a refusal names the field in error.data.field. An unknown field is refused, and so are the logos, which only the brand kit page can set. Any write marks the kit as configured. As a save on the brand kit page, a write does not restyle blocks of existing emails.',
		scope: 'brand-kit:write',
		pathParameters: [],
		queryParameters: [],
		idempotent: false,
		request: { name: 'BrandKitUpdateRequest', schema: brandKitUpdateRequestSchema },
		success: {
			status: 200,
			description: 'The brand kit as stored.',
			name: 'BrandKit',
			data: brandKitSchema,
			paginated: false,
		},
		errors: [422],
		reasons: ['template_write_rate_limited', ...WRITE_REFUSAL_REASONS],
	},
] as const satisfies readonly PublicOperation[];
