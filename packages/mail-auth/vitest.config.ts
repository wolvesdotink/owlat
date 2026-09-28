import { defineConfig } from 'vitest/config';
import { packageCoverage } from '../../vitest.shared';

export default defineConfig({
	test: {
		include: ['src/**/__tests__/**/*.test.ts'],
		environment: 'node',
		// The mailauth differential suites flaked once on the loaded release
		// runner (oracle verdict flip, unreproducible in 40 local runs). Mirror
		// apps/api's retry so a rare infra flake cannot kill a release gate;
		// real failures reproduce on retry and still fail.
		retry: 1,
		coverage: packageCoverage({
			lines: 90,
			thresholds: {
				// Branch coverage is enforced (plan doctrine) — the DKIM verify core,
				// canon, and key-record parsing all carry security-relevant branches
				// (l= cap, x= expiry, key/alg mismatch, hash restriction, PERMFAIL
				// paths) that must each be exercised, not just line-covered.
				branches: 85,
			},
			exclude: ['src/index.ts'],
		}),
	},
});
