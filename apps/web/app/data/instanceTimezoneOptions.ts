import type { TimezoneOption } from '~/data/languageOptions';

/**
 * The instance-level timezone catalog — the list the Instance → General
 * settings page offers for "this deployment's timezone". Wider than the
 * contact-level `timezoneOptions` in `languageOptions.ts` (which is scoped to
 * the zones a contact picker needs) and keyed under the settings page's own
 * message namespace, so the two stay independent.
 *
 * Module scope, so it carries message KEYS, not copy — `instanceTimezoneSelectOptions`
 * resolves them with the caller's translator.
 */
export const instanceTimezoneOptions: TimezoneOption[] = [
	{ value: '', label: 'dashboard.admin.instance.general.timezones.placeholder' },
	{ value: 'America/New_York', label: 'dashboard.admin.instance.general.timezones.americaNewYork' },
	{ value: 'America/Chicago', label: 'dashboard.admin.instance.general.timezones.americaChicago' },
	{ value: 'America/Denver', label: 'dashboard.admin.instance.general.timezones.americaDenver' },
	{
		value: 'America/Los_Angeles',
		label: 'dashboard.admin.instance.general.timezones.americaLosAngeles',
	},
	{
		value: 'America/Anchorage',
		label: 'dashboard.admin.instance.general.timezones.americaAnchorage',
	},
	{
		value: 'Pacific/Honolulu',
		label: 'dashboard.admin.instance.general.timezones.pacificHonolulu',
	},
	{ value: 'America/Phoenix', label: 'dashboard.admin.instance.general.timezones.americaPhoenix' },
	{ value: 'America/Toronto', label: 'dashboard.admin.instance.general.timezones.americaToronto' },
	{
		value: 'America/Vancouver',
		label: 'dashboard.admin.instance.general.timezones.americaVancouver',
	},
	{ value: 'Europe/London', label: 'dashboard.admin.instance.general.timezones.europeLondon' },
	{ value: 'Europe/Paris', label: 'dashboard.admin.instance.general.timezones.europeParis' },
	{ value: 'Europe/Berlin', label: 'dashboard.admin.instance.general.timezones.europeBerlin' },
	{
		value: 'Europe/Amsterdam',
		label: 'dashboard.admin.instance.general.timezones.europeAmsterdam',
	},
	{ value: 'Europe/Madrid', label: 'dashboard.admin.instance.general.timezones.europeMadrid' },
	{ value: 'Europe/Rome', label: 'dashboard.admin.instance.general.timezones.europeRome' },
	{ value: 'Europe/Zurich', label: 'dashboard.admin.instance.general.timezones.europeZurich' },
	{
		value: 'Europe/Stockholm',
		label: 'dashboard.admin.instance.general.timezones.europeStockholm',
	},
	{ value: 'Europe/Warsaw', label: 'dashboard.admin.instance.general.timezones.europeWarsaw' },
	{ value: 'Europe/Moscow', label: 'dashboard.admin.instance.general.timezones.europeMoscow' },
	{ value: 'Asia/Dubai', label: 'dashboard.admin.instance.general.timezones.asiaDubai' },
	{ value: 'Asia/Kolkata', label: 'dashboard.admin.instance.general.timezones.asiaKolkata' },
	{ value: 'Asia/Singapore', label: 'dashboard.admin.instance.general.timezones.asiaSingapore' },
	{ value: 'Asia/Hong_Kong', label: 'dashboard.admin.instance.general.timezones.asiaHongKong' },
	{ value: 'Asia/Shanghai', label: 'dashboard.admin.instance.general.timezones.asiaShanghai' },
	{ value: 'Asia/Tokyo', label: 'dashboard.admin.instance.general.timezones.asiaTokyo' },
	{ value: 'Asia/Seoul', label: 'dashboard.admin.instance.general.timezones.asiaSeoul' },
	{
		value: 'Australia/Sydney',
		label: 'dashboard.admin.instance.general.timezones.australiaSydney',
	},
	{
		value: 'Australia/Melbourne',
		label: 'dashboard.admin.instance.general.timezones.australiaMelbourne',
	},
	{
		value: 'Australia/Brisbane',
		label: 'dashboard.admin.instance.general.timezones.australiaBrisbane',
	},
	{ value: 'Australia/Perth', label: 'dashboard.admin.instance.general.timezones.australiaPerth' },
	{
		value: 'Pacific/Auckland',
		label: 'dashboard.admin.instance.general.timezones.pacificAuckland',
	},
	{ value: 'UTC', label: 'dashboard.admin.instance.general.timezones.utc' },
];

/**
 * `{ value, label }` pairs for the instance timezone `<select>`.
 *
 * A FUNCTION, not a frozen array: the labels are words, so they can only be
 * built where a translator is in hand. Callers pass `t` from `useI18n()` and
 * wrap the call in a `computed` so the labels follow the active locale.
 */
export function instanceTimezoneSelectOptions(
	translate: (key: string) => string
): { value: string; label: string }[] {
	return instanceTimezoneOptions.map((opt) => ({ value: opt.value, label: translate(opt.label) }));
}
