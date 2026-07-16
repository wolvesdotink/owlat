import { defineConfig } from 'vitest/config';

export default defineConfig({
	test: {
		include: ['convex/**/__tests__/**/*.test.ts'],
		exclude: ['convex/_generated/**'],
		setupFiles: ['./vitest.setup.ts'],
		environment: 'node',
		environmentMatchGlobs: [['convex/**/__tests__/**/*.integration.test.ts', 'edge-runtime']],
		server: { deps: { inline: ['convex-test'] } },
		// Integration tests run the real HTTP-router graph through convex-test, which
		// lazily transforms/imports the whole `convex/` tree on the first `t.fetch`
		// in a worker. That one-time cold-start can exceed a tight timeout for
		// whichever integration test lands first in a contended worker — a pure
		// environmental flake, not a logic bug. Give the cold-start headroom, and
		// retry: the re-run reuses the now-warm cache and passes in ms. Real failures
		// still fail all attempts (retries are reported as flaky, not hidden).
		//
		// These were 20s/retry:2 back when `ci:verify` ran every package in parallel
		// and oversubscribed the machine. Turborepo test caching now means only the
		// affected packages execute, so contention is far lower and the headroom was
		// tightened to 10s/retry:1. Watch CI for cold-start flakes and raise again if
		// they reappear.
		testTimeout: 10000,
		hookTimeout: 10000,
		retry: 1,
		// convex-test produces "Write outside of transaction" unhandled rejections
		// when mutations call ctx.scheduler.runAfter() — this is a known limitation
		dangerouslyIgnoreUnhandledErrors: true,
		coverage: {
			provider: 'v8',
			reporter: ['text', 'json-summary', 'html'],
			reportsDirectory: './coverage',
			include: ['convex/**/*.ts'],
			exclude: ['convex/_generated/**', 'convex/**/__tests__/**', 'convex/betterAuth/**'],
			// Ratchet baseline: the suite covers ~69% of lines (3300+ tests). Set a
			// few points below actual so the threshold guards real regressions
			// without flaking on run-to-run async/retry variance. Raise as coverage
			// climbs; never lower it without justification.
			thresholds: {
				lines: 65,
			},
		},
	},
});
