/**
 * The API quickstart table lists exactly the public routes the backend
 * registers, so a route added to the API cannot go missing from Settings.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { API_QUICKSTART_ROUTES } from '../apiQuickstartRoutes';
const HERE = dirname(fileURLToPath(import.meta.url));
const V1_HTTP = join(HERE, '../../../../api/convex/publicApi/v1Http.ts');
/** The contract's operation table and the modules of operations it splices in. */
const OPERATIONS = [
	'operations.ts',
	'templateOperations.ts',
	'renderOperations.ts',
	'brandKitOperations.ts',
].map((file) => join(HERE, '../../../../../packages/public-contract/src', file));

/** A catalog's endpoint descriptions, read untyped: the full catalog type is huge. */
function endpointDescriptions(locale: 'en' | 'de'): Record<string, string> {
	const catalog = JSON.parse(
		readFileSync(join(HERE, `../../../i18n/locales/${locale}.json`), 'utf8')
	);
	return catalog.dashboard.admin.team.api.docs.endpoints;
}

/** `METHOD /path` for every non-preflight route `v1Http.ts` registers. */
function registeredRoutes(): string[] {
	const source = readFileSync(V1_HTTP, 'utf8');
	const routes = [...source.matchAll(/(?:path|pathPrefix): '([^']+)',\s*method: '([A-Z]+)'/g)].map(
		([, path, method]) => `${method} ${path}`
	);
	return routes.filter((route) => !route.startsWith('OPTIONS ')).sort();
}

/** The table's rows in the same shape: a `:param` path is a prefix route. */
function tableRoutes(): string[] {
	return API_QUICKSTART_ROUTES.flatMap(({ methods, path }) => {
		const param = path.indexOf(':');
		const matched = param === -1 ? path : path.slice(0, param);
		return methods.map((method) => `${method} ${matched}`);
	}).sort();
}

/** `METHOD /path` for every operation of the public contract, `{param}` as `:param`. */
function contractRoutes(): string[] {
	const source = OPERATIONS.map((file) => readFileSync(file, 'utf8')).join('\n');
	return [...source.matchAll(/method: '([A-Z]+)',\s*path: '([^']+)'/g)]
		.map(([, method, path]) => `${method} ${path!.replace(/\{(\w+)\}/g, ':$1')}`)
		.sort();
}

describe('API quickstart routes', () => {
	it('names each route with the full path of the public contract', () => {
		const table = API_QUICKSTART_ROUTES.flatMap(({ methods, path }) =>
			methods.map((method) => `${method} ${path}`)
		);
		// The OpenAPI document and the block schema are served as they are and
		// are not operations of the contract.
		const served = new Set(['GET /api/v1/openapi.json', 'GET /api/v1/schemas/blocks.json']);
		expect(table.filter((route) => !served.has(route)).sort()).toEqual(contractRoutes());
	});

	it('lists every public route the backend registers, and no other', () => {
		const registered = registeredRoutes();
		expect(registered.length).toBeGreaterThan(10);
		expect([...new Set(tableRoutes())]).toEqual([...new Set(registered)]);
	});

	it('has a description in both catalogs for every row', () => {
		const en = endpointDescriptions('en');
		const de = endpointDescriptions('de');
		for (const { key } of API_QUICKSTART_ROUTES) {
			expect(en[key], key).toBeTruthy();
			expect(de[key], key).toBeTruthy();
		}
	});
});
