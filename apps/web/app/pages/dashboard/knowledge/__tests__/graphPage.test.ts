import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

/**
 * Markup guards for the knowledge-graph dashboard (audit item p9-graph-dashboard).
 *
 * The d3-force canvas and the analytics panels are client-only / data-driven and
 * awkward to mount in happy-dom, so these assert the load-bearing template facts
 * that have no pure logic to unit-test elsewhere:
 *   - the route is flag-gated on `ai.knowledge.analytics` (defence-in-depth on top
 *     of the composable's `'skip'` gating),
 *   - the container renders graph/insights ONLY when the flag resolves on,
 *   - component tags use the auto-import path prefix (`<KnowledgeGraph*>`), so they
 *     actually resolve instead of rendering nothing.
 */

const here = dirname(fileURLToPath(import.meta.url));
const read = (rel: string) => readFileSync(resolve(here, rel), 'utf8');

const graphPage = read('../graph.vue');
const graphView = read('../../../../components/knowledge/GraphView.vue');

describe('knowledge graph route — flag gating', () => {
	it('route is gated on ai.knowledge.analytics', () => {
		expect(graphPage).toContain("requiresFeature: 'ai.knowledge.analytics'");
		expect(graphPage).toContain("middleware: 'auth'");
		expect(graphPage).toContain("layout: 'dashboard'");
	});

	it('renders the graph view container', () => {
		expect(graphPage).toContain('<KnowledgeGraphView');
	});
});

describe('knowledge graph view — renders only when analytics is on', () => {
	it('gates the canvas/insights behind analyticsEnabled', () => {
		// The "off" branch is shown when the flag is off; the graph is the v-else.
		expect(graphView).toContain('v-if="!analyticsEnabled"');
		expect(graphView).toContain('Graph analytics are off');
		expect(graphView).toMatch(/analyticsEnabled/);
	});

	it('uses the path-prefixed auto-import component tags', () => {
		// Nuxt names subdir components with the dir prefix; the wrong name renders
		// nothing silently, so guard the exact tags the view depends on.
		expect(graphView).toContain('<KnowledgeGraphCanvas');
		expect(graphView).toContain('<KnowledgeGraphStatsPanel');
		expect(graphView).toContain('<KnowledgeRelationsList');
	});
});
