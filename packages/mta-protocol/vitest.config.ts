import { nodePackageConfig } from '../../vitest.shared';

export default nodePackageConfig({
	coverage: { exclude: ['src/index.ts'] },
});
