import { describe, it, expect } from 'vitest';
import { createFreezeLatch } from '../freezeLatch';

describe('createFreezeLatch', () => {
	const labels = {
		noun: 'block definition',
		registryName: 'block definition registry',
		plural: 'blocks',
		finalizeFn: 'finalizeBlockDefinitionRegistry',
	} as const;

	it('starts mutable and permits assertMutable', () => {
		const latch = createFreezeLatch(labels);
		expect(latch.isFrozen()).toBe(false);
		expect(() => latch.assertMutable('foo')).not.toThrow();
	});

	it('throws a registry-specific, id-bearing error once frozen', () => {
		const latch = createFreezeLatch(labels);
		latch.finalize();
		expect(latch.isFrozen()).toBe(true);
		expect(() => latch.assertMutable('foo')).toThrow(
			'Cannot register block definition "foo": the block definition registry is frozen. Register blocks during setup before finalizeBlockDefinitionRegistry().'
		);
	});

	it('finalize is idempotent and never flips back', () => {
		const latch = createFreezeLatch(labels);
		latch.finalize();
		latch.finalize();
		expect(latch.isFrozen()).toBe(true);
	});

	it('gives each latch its own independent frozen state', () => {
		const a = createFreezeLatch(labels);
		const b = createFreezeLatch({
			noun: 'editor module',
			registryName: 'editor module registry',
			plural: 'modules',
			finalizeFn: 'finalizeEditorModuleRegistry',
		});
		a.finalize();
		expect(a.isFrozen()).toBe(true);
		expect(b.isFrozen()).toBe(false);
		expect(() => b.assertMutable('x')).not.toThrow();
	});
});
