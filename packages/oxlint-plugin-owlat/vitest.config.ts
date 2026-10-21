import { nodePackageConfig } from '../../vitest.shared';

export default nodePackageConfig({
	coverage: {
		lines: 95,
		thresholds: { branches: 90 },
	},
});
