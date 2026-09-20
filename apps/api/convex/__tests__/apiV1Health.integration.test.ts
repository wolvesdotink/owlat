import { convexTest } from 'convex-test';
import { describe, it, expect, afterEach } from 'vitest';
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

const CORS_ENV_KEYS = ['ALLOWED_ORIGINS', 'SITE_URL', 'ADMIN_SITE_URL', 'OWLAT_DEV_MODE'];
const SAVED_ENV: Record<string, string | undefined> = {};

/**
 * Unset everything `lib/cors.ts:allowedOrigins()` consults — the state that
 * makes the credentialed helper throw. Scoped to the one test that needs it:
 * `vitest.setup.ts` supplies a default `SITE_URL` for every suite precisely
 * because unsetting it deployment-wide also trips BetterAuth's context init.
 */
function unconfigureCors(): void {
	for (const key of CORS_ENV_KEYS) {
		SAVED_ENV[key] = process.env[key];
		delete process.env[key];
	}
}

afterEach(() => {
	for (const key of CORS_ENV_KEYS) {
		if (SAVED_ENV[key] === undefined) delete process.env[key];
		else process.env[key] = SAVED_ENV[key];
	}
});

describe('GET /api/v1/health', () => {
	it('returns the documented { data } envelope', async () => {
		const t = convexTest(schema, modules);
		const res = await t.fetch('/api/v1/health', { method: 'GET' });
		const body = (await res.json()) as { data?: { status?: string; timestamp?: string } };
		expect(body.data?.status).toBe('ok');
		expect(typeof body.data?.timestamp).toBe('string');
	});

	/**
	 * Last on purpose: BetterAuth's context init also requires `SITE_URL`, and it
	 * is built once per process on the first routed fetch. Running the configured
	 * cases first lets it initialize, so unsetting the variable here exercises the
	 * CORS path without leaving an unrelated unhandled rejection in the run.
	 */
	it('answers 200 on a deployment with no CORS configuration at all', async () => {
		unconfigureCors();
		const t = convexTest(schema, modules);
		const res = await t.fetch('/api/v1/health', { method: 'GET' });
		expect(res.status).toBe(200);
		expect(res.headers.get('Access-Control-Allow-Origin')).toBe('*');
		// The credentialed posture must not leak onto a probe response.
		expect(res.headers.get('Access-Control-Allow-Credentials')).toBeNull();
	});

	it('answers its own OPTIONS preflight like every other v1 path', async () => {
		const t = convexTest(schema, modules);
		const res = await t.fetch('/api/v1/health', { method: 'OPTIONS' });
		expect(res.status).toBe(204);
		expect(res.headers.get('Access-Control-Allow-Methods')).toBe('GET, OPTIONS');
	});
});
