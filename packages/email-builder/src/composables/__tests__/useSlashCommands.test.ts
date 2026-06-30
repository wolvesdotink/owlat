import { describe, it, expect } from 'vitest';
import { useSlashCommands } from '../useSlashCommands';

// Ensure block definitions are registered
import '../../registry';

describe('useSlashCommands', () => {
	describe('initial state', () => {
		it('starts closed', () => {
			const { isOpen } = useSlashCommands();
			expect(isOpen.value).toBe(false);
		});
	});

	describe('open/close', () => {
		it('opens the menu', () => {
			const { open, isOpen } = useSlashCommands();
			open({ top: 100, left: 200 });
			expect(isOpen.value).toBe(true);
		});

		it('closes the menu', () => {
			const { open, close, isOpen } = useSlashCommands();
			open({ top: 100, left: 200 });
			close();
			expect(isOpen.value).toBe(false);
		});
	});

	describe('filteredCommands', () => {
		it('returns all commands when query is empty', () => {
			const { open, filteredCommands } = useSlashCommands();
			open({ top: 0, left: 0 });
			// Should include virtual commands (h1, h2, h3) + registered block commands
			expect(filteredCommands.value.length).toBeGreaterThan(3);
		});

		it('includes virtual heading commands', () => {
			const { open, filteredCommands } = useSlashCommands();
			open({ top: 0, left: 0 });
			const ids = filteredCommands.value.map((c) => c.id);
			expect(ids).toContain('h1');
			expect(ids).toContain('h2');
			expect(ids).toContain('h3');
		});

		it('filters by command name', () => {
			const { open, updateQuery, filteredCommands } = useSlashCommands();
			open({ top: 0, left: 0 });
			updateQuery('text');
			const names = filteredCommands.value.map((c) => c.name.toLowerCase());
			expect(names.some((n) => n.includes('text'))).toBe(true);
		});

		it('filters by command description', () => {
			const { open, updateQuery, filteredCommands } = useSlashCommands();
			open({ top: 0, left: 0 });
			updateQuery('paragraph');
			expect(filteredCommands.value.length).toBeGreaterThan(0);
		});

		it('filters by aliases', () => {
			const { open, updateQuery, filteredCommands } = useSlashCommands();
			open({ top: 0, left: 0 });
			updateQuery('title');
			const ids = filteredCommands.value.map((c) => c.id);
			expect(ids).toContain('h1'); // 'title' is an alias for h1
		});

		it('is case-insensitive', () => {
			const { open, updateQuery, filteredCommands } = useSlashCommands();
			open({ top: 0, left: 0 });
			updateQuery('TEXT');
			expect(filteredCommands.value.length).toBeGreaterThan(0);
		});

		it('returns empty array for non-matching query', () => {
			const { open, updateQuery, filteredCommands } = useSlashCommands();
			open({ top: 0, left: 0 });
			updateQuery('zzzznonexistent');
			expect(filteredCommands.value).toHaveLength(0);
		});
	});

	describe('navigation', () => {
		it('selectNext moves to the next command', () => {
			const { open, selectNext, filteredCommands, confirm } = useSlashCommands();
			open({ top: 0, left: 0 });
			const firstCmd = filteredCommands.value[0];
			const secondCmd = filteredCommands.value[1];

			// Without navigation, confirm returns first
			expect(confirm()?.id).toBe(firstCmd?.id);

			// Open again and navigate
			open({ top: 0, left: 0 });
			selectNext();
			expect(confirm()?.id).toBe(secondCmd?.id);
		});

		it('selectNext wraps around to first', () => {
			const { open, selectNext, filteredCommands, confirm } = useSlashCommands();
			open({ top: 0, left: 0 });
			const max = filteredCommands.value.length;
			const firstCmd = filteredCommands.value[0];

			for (let i = 0; i < max; i++) {
				selectNext();
			}
			// Should wrap back to first
			expect(confirm()?.id).toBe(firstCmd?.id);
		});

		it('selectPrevious wraps to last from start', () => {
			const { open, selectPrevious, filteredCommands, confirm } = useSlashCommands();
			open({ top: 0, left: 0 });
			const lastCmd = filteredCommands.value[filteredCommands.value.length - 1];

			selectPrevious();
			expect(confirm()?.id).toBe(lastCmd?.id);
		});

		it('selectNext then selectPrevious returns to original', () => {
			const { open, selectNext, selectPrevious, filteredCommands, confirm } = useSlashCommands();
			open({ top: 0, left: 0 });
			const firstCmd = filteredCommands.value[0];

			selectNext();
			selectNext();
			selectPrevious();
			selectPrevious();
			expect(confirm()?.id).toBe(firstCmd?.id);
		});

		it('selectNext does nothing with empty filtered list', () => {
			const { open, updateQuery, selectNext, confirm } = useSlashCommands();
			open({ top: 0, left: 0 });
			updateQuery('zzzznonexistent');
			selectNext();
			expect(confirm()).toBeNull();
		});

		it('selectPrevious does nothing with empty filtered list', () => {
			const { open, updateQuery, selectPrevious, confirm } = useSlashCommands();
			open({ top: 0, left: 0 });
			updateQuery('zzzznonexistent');
			selectPrevious();
			expect(confirm()).toBeNull();
		});
	});

	describe('setSavedBlocks', () => {
		it('adds saved blocks to filteredCommands', () => {
			const { open, filteredCommands, setSavedBlocks } = useSlashCommands();
			setSavedBlocks([
				{ _id: 'sb1', name: 'My Footer', content: '{}' },
				{ _id: 'sb2', name: 'My Header', description: 'Site header', content: '{}' },
			]);
			open({ top: 0, left: 0 });
			const ids = filteredCommands.value.map((c) => c.id);
			expect(ids).toContain('saved:sb1');
			expect(ids).toContain('saved:sb2');
			const footer = filteredCommands.value.find((c) => c.id === 'saved:sb1');
			expect(footer?.category).toBe('saved');
			expect(footer?.savedBlock?._id).toBe('sb1');
			// Clean up module-level state
			setSavedBlocks([]);
		});

		it('filters saved blocks by name', () => {
			const { open, updateQuery, filteredCommands, setSavedBlocks } = useSlashCommands();
			setSavedBlocks([
				{ _id: 'sb1', name: 'My Footer', content: '{}' },
				{ _id: 'sb2', name: 'My Header', content: '{}' },
			]);
			open({ top: 0, left: 0 });
			updateQuery('footer');
			const ids = filteredCommands.value.map((c) => c.id);
			expect(ids).toContain('saved:sb1');
			expect(ids).not.toContain('saved:sb2');
			// Clean up module-level state
			setSavedBlocks([]);
		});
	});

	describe('setAllowedBlockTypes', () => {
		it('restricts the slash menu to the allowlist', () => {
			const { open, filteredCommands, setAllowedBlockTypes } = useSlashCommands();
			setAllowedBlockTypes(['text', 'image', 'button', 'divider', 'spacer', 'columns']);
			open({ top: 0, left: 0 });
			const ids = filteredCommands.value.map((c) => c.id);
			expect(ids).toContain('image');
			expect(ids).toContain('button');
			expect(ids).not.toContain('video');
			expect(ids).not.toContain('accordion');
			expect(ids).not.toContain('hero');
			// Clean up module-level state
			setAllowedBlockTypes(undefined);
		});

		it('keeps heading commands when text is allowed', () => {
			const { open, filteredCommands, setAllowedBlockTypes } = useSlashCommands();
			setAllowedBlockTypes(['text', 'image']);
			open({ top: 0, left: 0 });
			const ids = filteredCommands.value.map((c) => c.id);
			expect(ids).toContain('h1');
			expect(ids).toContain('h2');
			expect(ids).toContain('h3');
			setAllowedBlockTypes(undefined);
		});

		it('drops heading commands when text is not allowed', () => {
			const { open, filteredCommands, setAllowedBlockTypes } = useSlashCommands();
			setAllowedBlockTypes(['image', 'button']);
			open({ top: 0, left: 0 });
			const ids = filteredCommands.value.map((c) => c.id);
			expect(ids).not.toContain('h1');
			expect(ids).not.toContain('h2');
			expect(ids).not.toContain('h3');
			setAllowedBlockTypes(undefined);
		});

		it('an empty allowlist is treated as "all"', () => {
			const { open, filteredCommands, setAllowedBlockTypes } = useSlashCommands();
			setAllowedBlockTypes([]);
			open({ top: 0, left: 0 });
			const ids = filteredCommands.value.map((c) => c.id);
			expect(ids).toContain('h1');
			expect(ids).toContain('video');
			setAllowedBlockTypes(undefined);
		});

		it('undefined restores the full command set', () => {
			const { open, filteredCommands, setAllowedBlockTypes } = useSlashCommands();
			setAllowedBlockTypes(['text']);
			setAllowedBlockTypes(undefined);
			open({ top: 0, left: 0 });
			const ids = filteredCommands.value.map((c) => c.id);
			expect(ids).toContain('video');
			expect(ids).toContain('hero');
		});
	});

	describe('confirm', () => {
		it('returns the first command by default', () => {
			const { open, filteredCommands, confirm } = useSlashCommands();
			open({ top: 0, left: 0 });
			const expected = filteredCommands.value[0];
			const result = confirm();
			expect(result?.id).toBe(expected?.id);
		});

		it('returns null when no commands match', () => {
			const { open, updateQuery, confirm } = useSlashCommands();
			open({ top: 0, left: 0 });
			updateQuery('zzzznonexistent');
			const result = confirm();
			expect(result).toBeNull();
		});

		it('closes the menu after confirm', () => {
			const { open, confirm, isOpen } = useSlashCommands();
			open({ top: 0, left: 0 });
			confirm();
			expect(isOpen.value).toBe(false);
		});

		it('returns command from filtered list when query is active', () => {
			const { open, updateQuery, confirm } = useSlashCommands();
			open({ top: 0, left: 0 });
			updateQuery('heading 1');
			const result = confirm();
			expect(result).not.toBeNull();
			expect(result!.id).toBe('h1');
		});
	});
});
