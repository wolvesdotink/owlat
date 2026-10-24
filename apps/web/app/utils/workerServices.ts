/**
 * Worker services as the System & updates page names them: the locale key of
 * each service (`components.system.workerVersionsCard.services.<key>`), which
 * the worker versions card and the data migrations card share.
 */
import type { WorkerService } from '@owlat/shared/workerWire';

const SERVICE_KEYS: Record<WorkerService, string> = {
	imap: 'imap',
	'mail-sync': 'mailSync',
	mta: 'mta',
	'code-worker': 'codeWorker',
};

export function workerServiceKey(service: WorkerService): string {
	return SERVICE_KEYS[service];
}
