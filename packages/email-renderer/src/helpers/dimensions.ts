export const toPixelWidth = (percent: number | undefined, baseWidth: number): number => {
	if (!Number.isFinite(percent)) return baseWidth;
	const clamped = Math.min(100, Math.max(1, percent as number));
	return Math.round((baseWidth * clamped) / 100);
};

export const toPercentNumber = (value: string, fallback = 100): number => {
	const parsed = Number.parseFloat(value.replace('%', '').trim());
	return Number.isFinite(parsed) ? parsed : fallback;
};
