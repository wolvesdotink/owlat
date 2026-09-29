import { nodePackageConfig } from '../../vitest.shared';

export default nodePackageConfig({
	coverage: {
		lines: 90,
		thresholds: {
			// Branch coverage is enforced (plan doctrine, U6) — canon carries the
			// security-relevant byte arithmetic (relaxed vs simple dispatch, WSP
			// collapse, trailing-CRLF stripping, b= tag anchoring) that must each
			// be exercised, not just line-covered.
			branches: 85,
		},
		exclude: ['src/index.ts'],
	},
});
