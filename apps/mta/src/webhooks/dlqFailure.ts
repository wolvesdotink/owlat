declare const webhookHttpStatusBrand: unique symbol;

export type WebhookHttpStatus = number & { readonly [webhookHttpStatusBrand]: true };

export type WebhookDeliveryFailure =
	| { category: 'transport' }
	| { category: 'deadline_exhausted' }
	| { category: 'unknown' }
	| { category: 'pending' }
	| { category: 'legacy' }
	| { category: 'http'; status: WebhookHttpStatus };

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null;
}

function isWebhookHttpStatus(value: unknown): value is WebhookHttpStatus {
	return typeof value === 'number' && Number.isInteger(value) && value >= 100 && value <= 599;
}

export function classifyWebhookHttpFailure(status: number): WebhookDeliveryFailure {
	return isWebhookHttpStatus(status) ? { category: 'http', status } : { category: 'unknown' };
}

export function parseDeliveryFailure(value: unknown): WebhookDeliveryFailure | null {
	if (!isRecord(value) || typeof value['category'] !== 'string') return null;
	switch (value['category']) {
		case 'transport':
		case 'deadline_exhausted':
		case 'unknown':
		case 'pending':
		case 'legacy':
			return { category: value['category'] };
		case 'http':
			return isWebhookHttpStatus(value['status'])
				? { category: 'http', status: value['status'] }
				: null;
		default:
			return null;
	}
}
