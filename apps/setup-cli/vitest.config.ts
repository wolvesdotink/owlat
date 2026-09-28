import { nodePackageConfig } from '../../vitest.shared';

export default nodePackageConfig({
	coverage: {
		// Measured 47.28% on 2026-09-28; two points of headroom
		// (scripts/quality-ratchets.md).
		lines: 45,
		// index.ts is the CLI entry: argv parsing and dispatch to the commands,
		// which are what the suites drive.
		exclude: ['src/index.ts'],
	},
	// Many cases pay a fixed cost per test (real scrypt password hashing, .env
	// and override files written to temp dirs), which inflates under the root
	// gate's parallelism, so take the shared budget (see vitest.timeouts.ts).
	// Asserted by src/__tests__/vitestTimeout.test.ts.
	timeout: 'parallel-gate',
});
