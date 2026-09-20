import { convexTest } from 'convex-test';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import schema from '../schema';

/**
 * The unauthenticated readiness probe at `GET /api/v1/health`.
 *
 * The probe is the first thing the setup CLI polls (apps/setup-cli
 * quickstart), i.e. it runs against deployments that have not been configured
 * yet. So the contract under test is specifically the *unconfigured* case: no
 * ALLOWED_ORIGINS, no SITE_URL, no dev-mode escape hatch — the combination that
 * makes the credentialed `lib/cors.ts:corsHeaders()` throw.
 */
const allModules = import.meta.glob('../**/*.*s');
const modules = Object.fromEntries(
	Object.entries(allModules).filter(
		([p]) =>
			!p.includes('sesActions') &&
			!p.includes('agentSecurity') &&
			!p.includes('agentContext') &&
			!p.includes('agentClassifier') &&
			!p.includes('agentDrafter') &&
			!p.includes('agentRouter') &&
			!p.includes('agent/walker') &&
			!p.includes('agent/steps/index') &&
			!p.includes('agent/steps/shared') &&
			!p.includes('agent/steps/classify') &&
			!p.includes('agent/steps/draft') &&
			!p.includes('knowledgeExtraction') &&
			!p.includes('semanticFileProcessing') &&
			!p.includes('visualizationAgent') &&
			!p.includes('llmProvider')
	)
);

const SAVED_ENV = { ...process.env };
beforeEach(() => {
	delete process.env['ALLOWED_ORIGINS'];
	delete process.env['SITE_URL'];
	delete process.env['ADMIN_SITE_URL'];
	delete process.env['OWLAT_DEV_MODE'];
});
afterEach(() => {
	process.env = { ...SAVED_ENV };
});

describe('GET /api/v1/health', () => {
	it('answers 200 on a deployment with no CORS configuration at all', async () => {
		const t = convexTest(schema, modules);
		const res = await t.fetch('/api/v1/health', { method: 'GET' });
		expect(res.status).toBe(200);
		expect(res.headers.get('Access-Control-Allow-Origin')).toBe('*');
		// The credentialed posture must not leak onto a probe response.
		expect(res.headers.get('Access-Control-Allow-Credentials')).toBeNull();
	});

	it('returns the documented { data } envelope', async () => {
		const t = convexTest(schema, modules);
		const res = await t.fetch('/api/v1/health', { method: 'GET' });
		const body = (await res.json()) as { data?: { status?: string; timestamp?: string } };
		expect(body.data?.status).toBe('ok');
		expect(typeof body.data?.timestamp).toBe('string');
	});

	it('answers its own OPTIONS preflight like every other v1 path', async () => {
		const t = convexTest(schema, modules);
		const res = await t.fetch('/api/v1/health', { method: 'OPTIONS' });
		expect(res.status).toBe(204);
		expect(res.headers.get('Access-Control-Allow-Methods')).toBe('GET, OPTIONS');
	});
});
