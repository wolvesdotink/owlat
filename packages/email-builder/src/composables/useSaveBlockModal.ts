import { ref, type ComputedRef, type Ref } from 'vue';
import type { EditorBlock } from '../types';
import { useEmailBuilderHandlers } from './useEmailBuilderHandlers';

export interface UseSaveBlockModalOptions {
	selectedBlock: ComputedRef<EditorBlock | null>;
}

export interface UseSaveBlockModalReturn {
	showSaveBlockModal: Ref<boolean>;
	saveBlockName: Ref<string>;
	isSavingBlock: Ref<boolean>;

	openSaveBlockModal: () => void;
	closeSaveBlockModal: () => void;
	saveAsReusableBlock: () => Promise<void>;
}

/**
 * Composable for managing the save block modal state
 */
export function useSaveBlockModal(options: UseSaveBlockModalOptions): UseSaveBlockModalReturn {
	const { selectedBlock } = options;
	const handlers = useEmailBuilderHandlers();

	const showSaveBlockModal = ref(false);
	const saveBlockName = ref('');
	const isSavingBlock = ref(false);

	const openSaveBlockModal = () => {
		saveBlockName.value = '';
		showSaveBlockModal.value = true;
	};

	const closeSaveBlockModal = () => {
		showSaveBlockModal.value = false;
		saveBlockName.value = '';
	};

	const saveAsReusableBlock = async () => {
		if (!selectedBlock.value || !saveBlockName.value.trim() || !handlers.savedBlocks?.save) return;

		isSavingBlock.value = true;
		try {
			await handlers.savedBlocks.save({
				name: saveBlockName.value.trim(),
				content: [selectedBlock.value],
			});
			closeSaveBlockModal();
		} catch {
			// Save failed silently
		} finally {
			isSavingBlock.value = false;
		}
	};

	return {
		showSaveBlockModal,
		saveBlockName,
		isSavingBlock,
		openSaveBlockModal,
		closeSaveBlockModal,
		saveAsReusableBlock,
	};
}
