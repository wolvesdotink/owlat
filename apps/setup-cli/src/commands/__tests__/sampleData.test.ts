/**
 * `owlat-setup sample-data` — argument parsing, plus static guards on the wiring
 * that makes the command reachable and keeps it OFF the dev-endpoint path.
 *
 * The guards matter more than the parser: the regression they pin is
 * quickstart silently writing `OWLAT_DEV_MODE=true` into a production `.env` to
 * make `/seed/demo` reachable — which also unlocks `POST /dev/reset` (full
 * instance wipe) and disables BetterAuth's rate limiting. Nothing in the runtime
 * tests would notice that coming back.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { parseAction, formatCounts } from '../sampleData.js';

const here = dirname(fileURLToPath(import.meta.url));
// apps/setup-cli/src/commands/__tests__ → repo root is five levels up.
const repoRoot = resolve(here, '../../../../..');
const quickstartSrc = readFileSync(resolve(here, '../quickstart.ts'), 'utf8');
const indexSrc = readFileSync(resolve(here, '../../index.ts'), 'utf8');
const owlatCli = readFileSync(resolve(repoRoot, 'scripts/owlat'), 'utf8');

describe('parseAction', () => {
	it('accepts the three actions', () => {
		expect(parseAction(['install'])).toBe('install');
		expect(parseAction(['remove'])).toBe('remove');
		expect(parseAction(['status'])).toBe('status');
	});

	it('reports usage when no action is given', () => {
		expect(parseAction([])).toEqual({ error: expect.stringContaining('install|remove|status') });
	});

	it('names the unknown action rather than guessing one', () => {
		const result = parseAction(['nuke']);
		expect(result).toEqual({ error: expect.stringContaining("'nuke'") });
	});

	it('ignores trailing arguments', () => {
		expect(parseAction(['remove', 'extra'])).toBe('remove');
	});
});

describe('formatCounts', () => {
	it('lists non-zero counts and drops the zeros', () => {
		const out = formatCounts({ contacts: 15, topics: 3, webhooks: 0 });
		expect(out).toContain('15 contacts');
		expect(out).toContain('3 topics');
		expect(out).not.toContain('webhooks');
	});

	it('says "none" for an empty result instead of an empty line', () => {
		expect(formatCounts({})).toContain('none');
		expect(formatCounts({ contacts: 0 })).toContain('none');
	});
});

describe('sample data stays off the dev-endpoint path', () => {
	it('quickstart never turns OWLAT_DEV_MODE on', () => {
		expect(quickstartSrc).not.toMatch(/OWLAT_DEV_MODE:\s*'true'/);
		expect(quickstartSrc).not.toMatch(/OWLAT_DEV_MODE['"]?\]?\s*=\s*['"]true/);
	});

	it('quickstart seeds a real install through the sample-data command', () => {
		expect(quickstartSrc).toContain("import { installSampleData } from './sampleData'");
		expect(quickstartSrc).toMatch(/devEndpointsEnabled \? runSeed : installSampleData/);
	});
});

describe('command wiring', () => {
	it('the CLI dispatches `sample-data` and documents it', () => {
		expect(indexSrc).toMatch(/case 'sample-data':/);
		expect(indexSrc).toContain('runSampleData');
		expect(indexSrc).toContain('sample-data <install|remove|status>');
	});

	it('scripts/owlat forwards `sample-data` to the setup container', () => {
		expect(owlatCli).toMatch(/^\tsample-data\)$/m);
		expect(owlatCli).toMatch(/"\$OWLAT_SETUP_IMAGE" sample-data "\$@"/);
		// It talks to the published Convex site port, so it needs host networking
		// (Linux) / host.docker.internal (Docker Desktop) like quickstart does.
		expect(owlatCli).toContain('OWLAT_LOCAL_HOST=host.docker.internal');
	});

	it('the `owlat --help` header lists it inside the printed range', () => {
		const range = /sed -n '4,(\d+)p'/.exec(owlatCli);
		expect(range).not.toBeNull();
		const lastLine = Number(range![1]);
		const helpLines = owlatCli.split('\n').slice(3, lastLine);
		expect(helpLines.join('\n')).toContain('owlat sample-data');
	});
});
