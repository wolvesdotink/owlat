import { defineConfig } from 'vitest/config';
import { packageCoverage } from '../../vitest.shared';

export default defineConfig({
	test: {
		// The tests sit beside their subject here rather than under __tests__,
		// so the include pattern is wider than the sibling kits'.
		include: ['src/**/*.test.ts'],
		environment: 'node',
		// One 32-statement file: a single uncovered branch moves the number
		// by ~3 points, so the floor sits well under the measured 93.75/93.54
		// rather than one edge case away from failing.
		coverage: packageCoverage({
			lines: 85,
			thresholds: { branches: 80 },
			exclude: ['src/**/*.test.ts', 'src/index.ts'],
		}),
	},
});
