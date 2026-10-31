import { computed, ref, type Ref } from 'vue';
import type { BrandBlockKind } from '../../types';
import { useBuilderI18n } from '../../i18n/useBuilderI18n';
import { useBrandKit, type UseBrandKitOptions } from '../useBrandKit';

interface UseBuilderBrandKitOptions extends UseBrandKitOptions {
	/** The root Block that owns the selection, if any. */
	selectedRootId: Ref<string | null>;
	handleSelectBlock: (blockId: string) => void;
	clearSelection: () => void;
}

/**
 * The builder's brand kit: inserting its logo and footer Blocks, and the
 * confirmed "Apply brand kit" restyle.
 */
export function useBuilderBrandKit(options: UseBuilderBrandKitOptions) {
	const { canvasBlocks, selectedRootId, handleSelectBlock, clearSelection } = options;
	const { t } = useBuilderI18n();

	// Brand kit: swatches for the colour pickers, the logo and footer Blocks, and
	// the "Apply brand kit" restyle (one undoable step).
	const { isBrandConfigured, insertableBrandBlocks, brandBlocksFor, heldRootCount, applyBrand } =
		useBrandKit(options);
	const showApplyBrandConfirm = ref(false);
	const applyBrandDescription = computed(() => {
		const base = t('builder.brand.applyDescription');
		const held = heldRootCount.value;
		if (held === 0) return base;
		return `${base} ${t('builder.brand.heldBlocks', { count: held })}`;
	});

	function confirmApplyBrand() {
		showApplyBrandConfirm.value = false;
		clearSelection();
		applyBrand();
	}

	/**
	 * Insert the brand kit's logo or footer as root Blocks at `index`, or, without
	 * one, after the selected Block; with nothing selected the logo goes on top
	 * and the footer at the bottom.
	 */
	function insertBrandBlocks(kind: BrandBlockKind, index?: number) {
		const blocks = brandBlocksFor(kind);
		if (blocks.length === 0) return;
		const anchor = selectedRootId.value
			? canvasBlocks.value.findIndex((b) => b.id === selectedRootId.value)
			: -1;
		const at =
			index ?? (anchor >= 0 ? anchor + 1 : kind === 'logo' ? 0 : canvasBlocks.value.length);
		canvasBlocks.value.splice(Math.min(at, canvasBlocks.value.length), 0, ...blocks);
		handleSelectBlock(blocks[0]!.id);
	}

	return {
		isBrandConfigured,
		insertableBrandBlocks,
		showApplyBrandConfirm,
		applyBrandDescription,
		confirmApplyBrand,
		insertBrandBlocks,
	};
}
