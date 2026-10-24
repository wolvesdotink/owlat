import { defineConfig } from 'tsup';

export default defineConfig({
	entry: ['src/index.ts'],
	format: ['esm', 'cjs'],
	// The wire types come from @owlat/public-contract, a private workspace
	// package that is never published: inline them into the declarations so
	// consumers resolve every type from this package alone. Its root export is
	// plain types; the declaration build widens `rootDir` to take them in.
	dts: {
		resolve: [/^@owlat\/public-contract$/],
		compilerOptions: { rootDir: '../..' },
	},
	clean: true,
	sourcemap: true,
	minify: false,
	target: 'node18',
	splitting: false,
	treeshake: true,
});
