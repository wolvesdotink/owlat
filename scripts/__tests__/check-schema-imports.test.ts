/**
 * Conformance for the schema import gate
 * (`apps/api/scripts/check-schema-imports.ts`).
 *
 * The gate walks the value-import closure of `convex/schema.ts` and
 * `convex/schema/*.ts` and fails when it reaches `_generated/api`,
 * `_generated/server` or `lib/sessionOrganization`, and it keeps
 * `lib/validators/` a leaf. These cases run the REAL script with the REAL
 * `lib/sourceGraph.ts` against throwaway trees, and once against the
 * repository itself.
 */

import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { API_ROOT } from './convexGates.testlib';

const GATE = 'scripts/check-schema-imports.ts';

const roots: string[] = [];
afterAll(() => {
	for (const root of roots) rmSync(root, { recursive: true, force: true });
});

interface GateRun {
	status: number;
	output: string;
}

function runIn(apiRoot: string): GateRun {
	const result = spawnSync('bun', [GATE], { cwd: apiRoot, encoding: 'utf8' });
	return { status: result.status ?? -1, output: `${result.stdout}${result.stderr}` };
}

/** A throwaway `apps/api` holding the real gate and `convex/<path>` files. */
function gate(files: Record<string, string>): GateRun {
	const root = mkdtempSync(join(tmpdir(), 'owlat-schema-imports-'));
	roots.push(root);
	for (const script of [GATE, 'scripts/lib/sourceGraph.ts']) {
		mkdirSync(dirname(join(root, script)), { recursive: true });
		copyFileSync(join(API_ROOT, script), join(root, script));
	}
	const tree: Record<string, string> = {
		'schema.ts': "import { widgetTables } from './schema/widgets';\nexport default widgetTables;\n",
		'_generated/api.d.ts': 'export declare const internal: unknown;\n',
		'_generated/server.d.ts': 'export declare const mutation: unknown;\n',
		'_generated/dataModel.d.ts': 'export type Doc = unknown;\n',
		'lib/sessionOrganization.ts': "import { components } from '../_generated/api';\n",
		...files,
	};
	for (const [path, contents] of Object.entries(tree)) {
		const target = join(root, 'convex', path);
		mkdirSync(dirname(target), { recursive: true });
		writeFileSync(target, contents);
	}
	return runIn(root);
}

const widgetSchema = (importLine: string): string =>
	[
		"import { defineTable } from 'convex/server';",
		importLine,
		'export const widgetTables = { widgets: defineTable({ status: statusValidator }) };',
		'',
	].join('\n');

/** A feature module holding a mutation next to the validator the schema wants. */
const featureModule = [
	"import { v } from 'convex/values';",
	"import { mutation } from '../_generated/server';",
	"export const statusValidator = v.union(v.literal('on'), v.literal('off'));",
	'export const setStatus = mutation({ args: {}, handler: async () => null });',
	'',
].join('\n');

describe('check-schema-imports.ts', () => {
	it('passes on the repository it guards', () => {
		const result = runIn(API_ROOT);
		expect(result.output).toContain('check-schema-imports: OK');
		expect(result.status).toBe(0);
	});

	it('passes when the schema imports its validator from lib/validators', () => {
		const result = gate({
			'schema/widgets.ts': widgetSchema(
				"import { statusValidator } from '../lib/validators/widgets';"
			),
			'lib/validators/widgets.ts':
				"import { v } from 'convex/values';\nexport const statusValidator = v.union(v.literal('on'));\n",
		});
		expect(result.output).toContain('check-schema-imports: OK');
		expect(result.status).toBe(0);
	});

	it('fails when a schema file imports a module that imports _generated/server', () => {
		const result = gate({
			'schema/widgets.ts': widgetSchema("import { statusValidator } from '../widgets/status';"),
			'widgets/status.ts': featureModule,
		});
		expect(result.status).toBe(1);
		expect(result.output).toContain('schema/widgets.ts -> widgets/status.ts -> _generated/server');
	});

	it('fails on a transitive path to _generated/api through the session read', () => {
		const result = gate({
			'schema/widgets.ts': widgetSchema("import { statusValidator } from '../widgets/shared';"),
			'widgets/shared.ts': [
				"import { v } from 'convex/values';",
				"import { getSession } from '../lib/sessionOrganization';",
				"export const statusValidator = v.union(v.literal('on'));",
				'export const read = getSession;',
				'',
			].join('\n'),
		});
		expect(result.status).toBe(1);
		expect(result.output).toContain(
			'schema/widgets.ts -> widgets/shared.ts -> lib/sessionOrganization.ts -> _generated/api'
		);
	});

	it('follows a re-export', () => {
		const result = gate({
			'schema/widgets.ts': widgetSchema("import { statusValidator } from '../widgets/index';"),
			'widgets/index.ts': "export { statusValidator } from './status';\n",
			'widgets/status.ts': featureModule,
		});
		expect(result.status).toBe(1);
		expect(result.output).toContain('widgets/index.ts -> widgets/status.ts -> _generated/server');
	});

	it('ignores `import type`, `export type` and all-inline-type clauses', () => {
		const result = gate({
			'schema/widgets.ts': [
				"import { defineTable } from 'convex/server';",
				"import { v } from 'convex/values';",
				"import type { setStatus } from '../widgets/status';",
				"import { type Status } from '../widgets/status';",
				"export type { Status as WidgetStatus } from '../widgets/status';",
				"import type { Doc } from '../_generated/dataModel';",
				'export const widgetTables = { widgets: defineTable({ status: v.string() }) };',
				'',
			].join('\n'),
			'widgets/status.ts': `${featureModule}export type Status = 'on' | 'off';\n`,
		});
		expect(result.output).toContain('check-schema-imports: OK');
		expect(result.status).toBe(0);
	});

	it('ignores an import that only appears in a comment', () => {
		const result = gate({
			'schema/widgets.ts': widgetSchema(
				[
					"import { statusValidator } from '../lib/validators/widgets';",
					"// import { setStatus } from '../widgets/status';",
				].join('\n')
			),
			'lib/validators/widgets.ts':
				"import { v } from 'convex/values';\nexport const statusValidator = v.union(v.literal('on'));\n",
			'widgets/status.ts': featureModule,
		});
		expect(result.status).toBe(0);
	});

	it('fails when a lib/validators module loads a module outside its leaf set', () => {
		const result = gate({
			'schema/widgets.ts': widgetSchema(
				"import { statusValidator } from '../lib/validators/widgets';"
			),
			'lib/validators/widgets.ts': [
				"import { v } from 'convex/values';",
				"import { WIDGET_STATES } from '../../widgets/catalog';",
				'export const statusValidator = v.union(...WIDGET_STATES.map(v.literal));',
				'',
			].join('\n'),
			'widgets/catalog.ts': "export const WIDGET_STATES = ['on'] as const;\n",
		});
		expect(result.status).toBe(1);
		expect(result.output).toContain('lib/validators/widgets.ts -> widgets/catalog.ts');
	});

	it('fails when a lib/validators module loads a package other than convex/values or @owlat/*', () => {
		const result = gate({
			'schema/widgets.ts': widgetSchema(
				"import { statusValidator } from '../lib/validators/widgets';"
			),
			'lib/validators/widgets.ts': [
				"import { v } from 'convex/values';",
				"import { z } from 'zod';",
				"import { WIDGETS } from '@owlat/shared';",
				"export const statusValidator = v.union(v.literal('on'));",
				'export const schemas = [z, WIDGETS];',
				'',
			].join('\n'),
		});
		expect(result.status).toBe(1);
		expect(result.output).toContain('lib/validators/widgets.ts -> zod');
		expect(result.output).not.toContain('-> @owlat/shared');
	});

	it('fails on an unresolvable relative import rather than skipping it', () => {
		const result = gate({
			'schema/widgets.ts': widgetSchema("import { statusValidator } from '../widgets/missing';"),
		});
		expect(result.status).toBe(1);
		expect(result.output).toContain("schema/widgets.ts: cannot resolve '../widgets/missing'");
	});
});
