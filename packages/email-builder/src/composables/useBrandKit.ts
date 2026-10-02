import { computed, onScopeDispose, provide, watch, type ComputedRef, type Ref } from 'vue';
import { brandSwatches } from '@owlat/shared/brandKit';
import { applyBrandKit, brandFooterBlocks, brandLogoBlock } from '@owlat/shared/brandKitBlocks';
import type {
	BlockType,
	BrandBlockKind,
	EditorBlock,
	EmailBuilderBrand,
	EmailTheme,
} from '../types';
import { generateId } from '../utils/id';

/** The injection key ColorField reads the brand swatches from. */
export const BRAND_SWATCHES_KEY = 'brandSwatches';

export interface UseBrandKitOptions {
	brand: ComputedRef<EmailBuilderBrand | undefined>;
	theme: ComputedRef<EmailTheme>;
	/** The host's Block allowlist (`config.blockTypes`); brand Blocks outside it are left out. */
	allowedBlockTypes: ComputedRef<BlockType[] | undefined>;
	canvasBlocks: Ref<EditorBlock[]>;
	/** Commit an edit still inside the history debounce, so a restyle is its own undo step. */
	commitPendingHistory: () => void;
}

export interface UseBrandKitReturn {
	/** True once the organization has saved a brand kit. */
	isBrandConfigured: ComputedRef<boolean>;
	/** The brand Blocks there is something to insert for. */
	insertableBrandBlocks: ComputedRef<BrandBlockKind[]>;
	/** Fresh Blocks for the logo or the footer; `[]` when the kit has none. */
	brandBlocksFor: (kind: BrandBlockKind) => EditorBlock[];
	/** Restyle the whole email with the kit as one undoable step; returns the Blocks changed. */
	applyBrand: () => number;
}

/**
 * The brand kit inside the editor: the swatches every colour picker leads
 * with, the logo and footer Blocks, the "Apply brand kit" restyle, and the
 * kit's web fonts loaded into the page so the canvas draws text in them.
 */
export function useBrandKit(options: UseBrandKitOptions): UseBrandKitReturn {
	const { brand, theme, allowedBlockTypes, canvasBlocks, commitPendingHistory } = options;

	const isBrandConfigured = computed(() => brand.value?.design.isConfigured === true);

	provide(
		BRAND_SWATCHES_KEY,
		computed(() => (isBrandConfigured.value ? brandSwatches(brand.value!.design) : []))
	);

	function brandBlocksFor(kind: BrandBlockKind): EditorBlock[] {
		const kit = brand.value;
		if (!kit?.design.isConfigured) return [];
		const logo = kind === 'logo' ? brandLogoBlock(kit.design, kit.logos, () => generateId()) : null;
		const blocks =
			kind === 'logo' ? (logo ? [logo] : []) : brandFooterBlocks(kit.design, () => generateId());
		const allowed = allowedBlockTypes.value;
		return allowed ? blocks.filter((block) => allowed.includes(block.type)) : blocks;
	}

	const insertableBrandBlocks = computed<BrandBlockKind[]>(() =>
		(['logo', 'footer'] as const).filter((kind) => brandBlocksFor(kind).length > 0)
	);

	function applyBrand(): number {
		const kit = brand.value;
		if (!kit?.design.isConfigured) return 0;
		commitPendingHistory();
		const result = applyBrandKit(canvasBlocks.value, kit.design);
		if (result.changedCount > 0) canvasBlocks.value = result.blocks;
		return result.changedCount;
	}

	// The canvas is drawn in the page, not in the email's own document, so the
	// kit's web fonts have to be linked here for the canvas to show them.
	const fontLinks: HTMLLinkElement[] = [];
	const clearFontLinks = () => {
		for (const link of fontLinks.splice(0)) link.remove();
	};
	if (typeof document !== 'undefined') {
		watch(
			() => (theme.value.fontUrls ?? []).join('\n'),
			(joined) => {
				clearFontLinks();
				for (const href of joined ? joined.split('\n') : []) {
					const link = document.createElement('link');
					link.rel = 'stylesheet';
					link.href = href;
					link.dataset['owlatBrandFont'] = 'true';
					document.head.appendChild(link);
					fontLinks.push(link);
				}
			},
			{ immediate: true }
		);
		onScopeDispose(clearFontLinks);
	}

	return { isBrandConfigured, insertableBrandBlocks, brandBlocksFor, applyBrand };
}
