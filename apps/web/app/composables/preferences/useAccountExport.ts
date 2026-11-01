/**
 * The account page's data export: the manifest read before a run, the JSON
 * export with its row count, and the contacts CSV. The page creates this so the
 * manifest is read when the page opens; the export card only renders it.
 */
import type { Ref } from 'vue';
import { sanitizeCsvCell } from '@owlat/shared';
import { api } from '@owlat/api';
import Papa from 'papaparse';
import { writeAccountJsonExport } from '~/utils/accountJsonExport';
import {
	isSaveFilePickerCancellation,
	openIncrementalJsonDownload,
} from '~/utils/incrementalJsonDownload';
import {
	accountExportPercent,
	buildAccountExportManifest,
	plannedRowTotal,
	type AccountExportManifestRow,
} from '~/utils/accountExportProgress';

export function useAccountExport(options: {
	userId: Readonly<Ref<string | null>>;
	hasActiveOrganization: Readonly<Ref<boolean>>;
}) {
	const { userId, hasActiveOrganization } = options;
	const { t } = useI18n();
	const convex = useConvex();

	// Toast notifications (global)
	const { showToast: showNotification } = useToast();

	// Export state
	const isExportingJson = ref(false);
	const isExportingCsv = ref(false);

	// ── Export manifest + progress (idea 67) ───────────────────────────────────
	// The manifest is read BEFORE the run so the card can say what the file will
	// contain and how much of it there is; the bar then counts rows actually
	// written against that plan. Both are pure derivations in
	// `~/utils/accountExportProgress`.
	const exportManifest = ref<AccountExportManifestRow[]>([]);
	const isManifestLoading = ref(false);
	const exportedRows = ref(0);
	const plannedRows = computed(() => plannedRowTotal(exportManifest.value));
	const exportPercent = computed(() =>
		accountExportPercent({ rowsWritten: exportedRows.value, plannedRows: plannedRows.value })
	);

	async function loadExportManifest() {
		if (!userId.value || !convex) return;
		isManifestLoading.value = true;
		try {
			const plan = await convex.action(api.auth.accountExport.getExportPlan, {
				userId: userId.value,
			});
			exportManifest.value = buildAccountExportManifest(plan);
		} catch {
			// A manifest is an extra: failing to read it must never block the export
			// itself, so the card falls back to "we could not count this in advance".
			exportManifest.value = [];
		} finally {
			isManifestLoading.value = false;
		}
	}
	watch(userId, (id) => void (id ? loadExportManifest() : undefined), { immediate: true });

	// Export all data as JSON
	const handleExportJson = async () => {
		if (!userId.value || !convex) return;

		isExportingJson.value = true;
		exportedRows.value = 0;

		try {
			const filename = `owlat-data-export-${new Date().toISOString().split('T')[0]}.json`;
			// The native picker requires the original click's transient user activation,
			// so open the destination before the first network request.
			const sink = await openIncrementalJsonDownload(filename);
			await writeAccountJsonExport(convex, userId.value, sink, () => {
				exportedRows.value += 1;
			});

			showNotification(t('dashboard.preferences.account.exportJsonSuccess'));
		} catch (error) {
			if (isSaveFilePickerCancellation(error)) return;
			showNotification(t('dashboard.preferences.account.exportJsonFailed'), 'error');
		} finally {
			isExportingJson.value = false;
		}
	};

	// Export contacts as CSV
	const handleExportCsv = async () => {
		if (!hasActiveOrganization.value || !convex) return;

		isExportingCsv.value = true;

		try {
			const data = await convex.query(api.auth.accountManagement.exportContactsForOrganization, {});

			// Build CSV headers — must match the fields returned by
			// exportContactsForOrganization (no subscription columns are returned).
			const baseHeaders = [
				'email',
				'firstName',
				'lastName',
				'source',
				'timezone',
				'createdAt',
				'updatedAt',
				'topics',
			];
			const allHeaders = [...baseHeaders, ...data.properties];

			// Generate CSV
			const sanitizedContacts = data.contacts.map((row: Record<string, unknown>) =>
				Object.fromEntries(
					Object.entries(row).map(([k, v]) => [k, typeof v === 'string' ? sanitizeCsvCell(v) : v])
				)
			);
			const csv = Papa.unparse({
				fields: allHeaders,
				data: sanitizedContacts,
			});

			// Create and download CSV file
			const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
			const url = URL.createObjectURL(blob);
			const a = document.createElement('a');
			a.href = url;
			a.download = `contacts-export-${new Date().toISOString().split('T')[0]}.csv`;
			document.body.appendChild(a);
			a.click();
			document.body.removeChild(a);
			URL.revokeObjectURL(url);

			showNotification(t('dashboard.preferences.account.exportCsvSuccess'));
		} catch {
			showNotification(t('dashboard.preferences.account.exportCsvFailed'), 'error');
		} finally {
			isExportingCsv.value = false;
		}
	};

	return {
		isExportingJson,
		isExportingCsv,
		exportManifest,
		isManifestLoading,
		exportedRows,
		exportPercent,
		handleExportJson,
		handleExportCsv,
	};
}
