import { nodePackageConfig } from '../../vitest.shared';

export default nodePackageConfig({
	coverage: { exclude: ['src/schemas.ts', 'src/types.ts'] },
});
