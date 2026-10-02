import { reactive, computed, ref, type ComputedRef } from 'vue';
import { PanelBottom, Stamp } from '@lucide/vue';
import type { SlashCommand, SlashMenuState, SavedBlock, BlockType, BrandBlockKind } from '../types';
import { getSlashCommands } from '../registry';

export interface UseSlashCommandsReturn {
	state: SlashMenuState;
	isOpen: ComputedRef<boolean>;
	filteredCommands: ComputedRef<SlashCommand[]>;
	open: (position: { top: number; left: number }) => void;
	close: () => void;
	updateQuery: (query: string) => void;
	selectNext: () => void;
	selectPrevious: () => void;
	confirm: () => SlashCommand | null;
	setSavedBlocks: (blocks: SavedBlock[]) => void;
	setAllowedBlockTypes: (types: BlockType[] | undefined) => void;
	setBrandBlocks: (kinds: BrandBlockKind[]) => void;
}

// Virtual commands (not in registry, hand-crafted)
const headingCommands: SlashCommand[] = [
	{
		id: 'h1',
		name: 'Heading 1',
		description: 'Large heading',
		icon: null,
		category: 'text',
		aliases: ['h1', 'title'],
	},
	{
		id: 'h2',
		name: 'Heading 2',
		description: 'Medium heading',
		icon: null,
		category: 'text',
		aliases: ['h2', 'subtitle'],
	},
	{
		id: 'h3',
		name: 'Heading 3',
		description: 'Small heading',
		icon: null,
		category: 'text',
		aliases: ['h3'],
	},
];

// Module-level ref so all useSlashCommands() instances share the same saved blocks
const savedBlocks = ref<SavedBlock[]>([]);

// Module-level allowlist mirroring `EmailBuilderConfig.blockTypes`. `undefined`
// means "all blocks" (the default); a list restricts the insertable palette.
// Shared at module level so every instance (EmailBuilder + each InlineTextEditor)
// honours the host config without prop-drilling through the canvas.
const allowedBlockTypes = ref<BlockType[] | undefined>(undefined);

// The brand kit Blocks there is something to insert for (useBrandKit), shared
// like the saved blocks so every slash menu instance offers them.
const brandBlockKinds = ref<BrandBlockKind[]>([]);

const BRAND_COMMANDS: Record<BrandBlockKind, SlashCommand> = {
	logo: {
		id: 'brand:logo',
		name: 'Logo',
		description: 'Your brand kit logo',
		icon: Stamp,
		category: 'brand',
		aliases: ['brand', 'logo'],
		brandBlock: 'logo',
	},
	footer: {
		id: 'brand:footer',
		name: 'Footer',
		description: 'Company name, address and social links',
		icon: PanelBottom,
		category: 'brand',
		aliases: ['brand', 'footer', 'address'],
		brandBlock: 'footer',
	},
};

const savedBlockCommands = computed<SlashCommand[]>(() => {
	return savedBlocks.value.map((block) => ({
		id: `saved:${block._id}`,
		name: block.name,
		description: block.description || 'Saved block',
		icon: null,
		category: 'saved' as const,
		savedBlock: block,
	}));
});

/**
 * Composable for slash command menu state and navigation.
 */
export function useSlashCommands(): UseSlashCommandsReturn {
	const state = reactive<SlashMenuState>({
		isOpen: false,
		position: { top: 0, left: 0 },
		query: '',
		selectedIndex: 0,
	});

	const isOpen = computed(() => state.isOpen);

	function setSavedBlocks(blocks: SavedBlock[]) {
		savedBlocks.value = blocks;
	}

	function setAllowedBlockTypes(types: BlockType[] | undefined) {
		allowedBlockTypes.value = types && types.length > 0 ? types : undefined;
	}

	function setBrandBlocks(kinds: BrandBlockKind[]) {
		brandBlockKinds.value = kinds;
	}

	const allCommands = computed<SlashCommand[]>(() => {
		const allowed = allowedBlockTypes.value;
		// Heading commands all produce a `text` block, so they ride along with it.
		const headings = !allowed || allowed.includes('text') ? headingCommands : [];
		return [
			...headings,
			...getSlashCommands(allowed),
			// Already narrowed to the allowlist by the editor (useBrandKit).
			...brandBlockKinds.value.map((kind) => BRAND_COMMANDS[kind]),
			...savedBlockCommands.value,
		];
	});

	const filteredCommands = computed<SlashCommand[]>(() => {
		const q = state.query.toLowerCase();
		if (!q) return allCommands.value;
		return allCommands.value.filter((cmd) => {
			if (cmd.name.toLowerCase().includes(q)) return true;
			if (cmd.description.toLowerCase().includes(q)) return true;
			if (cmd.aliases?.some((a) => a.toLowerCase().includes(q))) return true;
			return false;
		});
	});

	function open(position: { top: number; left: number }) {
		state.isOpen = true;
		state.position = position;
		state.query = '';
		state.selectedIndex = 0;
	}

	function close() {
		state.isOpen = false;
		state.query = '';
		state.selectedIndex = 0;
	}

	function updateQuery(query: string) {
		state.query = query;
		state.selectedIndex = 0;
	}

	function selectNext() {
		const max = filteredCommands.value.length;
		if (max === 0) return;
		state.selectedIndex = (state.selectedIndex + 1) % max;
	}

	function selectPrevious() {
		const max = filteredCommands.value.length;
		if (max === 0) return;
		state.selectedIndex = (state.selectedIndex - 1 + max) % max;
	}

	function confirm(): SlashCommand | null {
		const cmds = filteredCommands.value;
		if (cmds.length === 0) return null;
		const selected = cmds[state.selectedIndex];
		close();
		return selected ?? null;
	}

	return {
		state,
		isOpen,
		filteredCommands,
		open,
		close,
		updateQuery,
		selectNext,
		selectPrevious,
		confirm,
		setSavedBlocks,
		setAllowedBlockTypes,
		setBrandBlocks,
	};
}
