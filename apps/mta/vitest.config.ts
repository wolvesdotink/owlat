import { defineConfig } from 'vitest/config';
import { packageCoverage } from '../../vitest.shared';
import { PARALLEL_GATE_TIMEOUT_MS } from '../../vitest.timeouts';

export default defineConfig({
	test: {
		include: ['src/**/__tests__/**/*.test.ts'],
		environment: 'node',
		setupFiles: ['./vitest.setup.ts'],
		// Suite hooks start real Redis containers: one node takes ~0.4s alone, a
		// three-node cluster ~3-4s before its slots converge, and both inflate
		// under the parallel release gate. That fixed cost is what the shared
		// budget is for. Test bodies keep vitest's default, so a hung socket or
		// script inside a test still fails fast.
		hookTimeout: PARALLEL_GATE_TIMEOUT_MS,
		coverage: packageCoverage({
			lines: 87,
			exclude: ['src/index.ts', 'src/server.ts'],
		}),
	},
});
