import { defineConfig } from 'vitest/config';
import { coverageReports } from '../../vitest.shared';

export default defineConfig({
	test: {
		include: ['__tests__/**/*.test.ts'],
		environment: 'node',
		// Reports only: no file selection and no floor, so the report covers just
		// what the page-invariant suites load.
		coverage: coverageReports(),
	},
});
