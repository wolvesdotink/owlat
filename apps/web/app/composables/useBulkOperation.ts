import { ref, readonly } from 'vue';

export interface BulkOperationOptions<R = void> {
	/**
	 * Number of items to process per batch (default: 50)
	 */
	batchSize?: number;
	/**
	 * Type identifier for the operation (e.g., 'add', 'remove', 'delete', 'export')
	 */
	type?: string;
	/**
	 * Callback invoked after each batch with the result
	 */
	onBatchComplete?: (batchResult: R, batchIndex: number, totalBatches: number) => void;
}

export interface BulkOperationResult<R> {
	success: boolean;
	results: R[];
	error?: Error;
}

/**
 * Composable for managing bulk operations with progress tracking.
 *
 * @example
 * ```ts
 * const bulkOp = useBulkOperation();
 *
 * const handleBulkDelete = async () => {
 *   const result = await bulkOp.execute(
 *     selectedIds,
 *     async (batch) => {
 *       return await deleteContacts({ contactIds: batch });
 *     },
 *     { batchSize: 25, type: 'delete' }
 *   );
 * };
 * ```
 */
export function useBulkOperation() {
	const isInProgress = ref(false);
	const progress = ref(0);
	const operationType = ref<string | null>(null);

	/**
	 * Execute a bulk operation on a list of items, processing them in batches.
	 *
	 * @param items - Array of items to process
	 * @param operation - Async function to execute on each batch
	 * @param options - Configuration options
	 * @returns Result object with success status and batch results
	 */
	async function execute<T, R = void>(
		items: T[],
		operation: (batch: T[]) => Promise<R>,
		options: BulkOperationOptions<R> = {}
	): Promise<BulkOperationResult<R>> {
		const { batchSize = 50, type = null, onBatchComplete } = options;

		if (items.length === 0) {
			return { success: true, results: [] };
		}

		isInProgress.value = true;
		operationType.value = type;
		progress.value = 0;

		const results: R[] = [];
		const totalBatches = Math.ceil(items.length / batchSize);

		try {
			for (let i = 0; i < totalBatches; i++) {
				const batch = items.slice(i * batchSize, (i + 1) * batchSize);
				const batchResult = await operation(batch);
				results.push(batchResult);

				// Update progress after each batch
				progress.value = Math.round(((i + 1) / totalBatches) * 100);

				// Call optional callback
				if (onBatchComplete) {
					onBatchComplete(batchResult, i, totalBatches);
				}
			}

			return { success: true, results };
		} catch (error) {
			return {
				success: false,
				results,
				error: error instanceof Error ? error : new Error(String(error)),
			};
		} finally {
			isInProgress.value = false;
			operationType.value = null;
			progress.value = 0;
		}
	}

	/**
	 * Reset the operation state (useful if you need to abort and reset manually)
	 */
	function reset() {
		isInProgress.value = false;
		progress.value = 0;
		operationType.value = null;
	}

	return {
		isInProgress: readonly(isInProgress),
		progress: readonly(progress),
		operationType: readonly(operationType),
		execute,
		reset,
	};
}
