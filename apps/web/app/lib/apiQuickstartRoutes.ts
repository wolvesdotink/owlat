/**
 * The rows of the API quickstart table (Settings → API → quickstart): every
 * public `/api/v1` route this instance serves, grouped by path.
 *
 * The routes are registered in `apps/api/convex/publicApi/v1Http.ts` and
 * described in `packages/public-contract/src/operations.ts`; a test compares
 * the table with both, so a route added there fails until it has a row here.
 * A path parameter is written `:name`; everything from the first `:` on is the
 * part the router matches by prefix.
 *
 * Pure: no Vue, no Nuxt.
 */
export interface ApiQuickstartRoute {
	methods: readonly ('GET' | 'POST' | 'PUT' | 'DELETE')[];
	path: string;
	/** The description's message key under `dashboard.admin.team.api.docs.endpoints`. */
	key: string;
}

export const API_QUICKSTART_ROUTES: readonly ApiQuickstartRoute[] = [
	{ methods: ['GET', 'POST'], path: '/api/v1/contacts', key: 'contacts' },
	{ methods: ['GET', 'PUT', 'DELETE'], path: '/api/v1/contacts/:id', key: 'contact' },
	{ methods: ['POST'], path: '/api/v1/events', key: 'events' },
	{ methods: ['GET', 'POST'], path: '/api/v1/transactional', key: 'transactional' },
	{ methods: ['GET'], path: '/api/v1/transactional/:sendId', key: 'transactionalSend' },
	{ methods: ['GET'], path: '/api/v1/status', key: 'status' },
	{ methods: ['GET'], path: '/api/v1/domains', key: 'domains' },
	{ methods: ['GET'], path: '/api/v1/limits', key: 'limits' },
	{ methods: ['GET'], path: '/api/v1/topics', key: 'topics' },
	{ methods: ['POST'], path: '/api/v1/topics/:topicId/contacts', key: 'topicContactAdd' },
	{
		methods: ['DELETE'],
		path: '/api/v1/topics/:topicId/contacts/:emailOrId',
		key: 'topicContactRemove',
	},
	{ methods: ['GET'], path: '/api/v1/health', key: 'health' },
	{ methods: ['GET'], path: '/api/v1/openapi.json', key: 'openapi' },
];
