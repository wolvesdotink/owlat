/**
 * Every Convex function the mail-sync worker (apps/mail-sync) calls, by the name
 * its `fn` table uses. apps/api registers each one's `args` and `returns` from
 * here; apps/mail-sync builds its function references and its result checks
 * from here.
 */

import { getCredentialsForWorker, listConnectableAccounts, setSyncStatus } from './accounts';
import {
	completeBackfillImport,
	findKnownMessageIds,
	getBackfillWork,
	initFolderBackfill,
	markImportFailed,
	pauseImportForThrottle,
	recordBackfillProgress,
} from './backfill';
import {
	discardStagedRaw,
	getSyncState,
	ingestExternalRaw,
	recordFolderMapping,
	recordForwardIngestFailure,
} from './delivery';
import {
	listDueRemoteOps,
	listQueuedFolderRenames,
	recordRemoteFolderRename,
	settleRemoteOps,
} from './remoteOps';
import {
	applyRemoteObservations,
	forgetRemoteFolders,
	getSyncSettings,
	listLocalMessages,
	lookupLocalMessages,
	markFullSyncAligned,
} from './remoteState';
import { listSeedProbeWork, recordSeedProbeClassification } from './seedProbes';
import { reportWorker } from './workerReport';

export * from './accounts';
export * from './backfill';
export * from './delivery';
export * from './remoteOps';
export * from './remoteState';
export * from './seedProbes';
export * from './workerReport';

export const MAIL_SYNC_ENDPOINTS = {
	getCredentialsForWorker,
	listConnectableAccounts,
	setSyncStatus,
	ingestExternalRaw,
	discardStagedRaw,
	getSyncState,
	recordFolderMapping,
	recordForwardIngestFailure,
	listSeedProbeWork,
	recordSeedProbeClassification,
	getBackfillWork,
	initFolderBackfill,
	findKnownMessageIds,
	recordBackfillProgress,
	completeBackfillImport,
	markImportFailed,
	pauseImportForThrottle,
	listDueRemoteOps,
	settleRemoteOps,
	recordRemoteFolderRename,
	listQueuedFolderRenames,
	getSyncSettings,
	listLocalMessages,
	lookupLocalMessages,
	applyRemoteObservations,
	markFullSyncAligned,
	forgetRemoteFolders,
	reportWorker,
} as const;
