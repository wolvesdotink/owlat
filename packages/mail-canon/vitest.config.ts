import { defineConfig } from 'vitest/config';

export default defineConfig({
	test: {
		include: ['src/**/__tests__/**/*.test.ts'],
		environment: 'node',
		coverage: {
			provider: 'v8',
			reporter: ['text', 'json-summary', 'html'],
			reportsDirectory: './coverage',
			include: ['src/**/*.ts'],
			exclude: ['src/**/__tests__/**', 'src/index.ts'],
			thresholds: {
				lines: 90,
				// Branch coverage is enforced (plan doctrine, U6) — canon carries the
				// security-relevant byte arithmetic (relaxed vs simple dispatch, WSP
				// collapse, trailing-CRLF stripping, b= tag anchoring) that must each
				// be exercised, not just line-covered.
				branches: 85,
			},
		},
	},
});
