// Time zone abbreviations. Browsers only name a handful of zones (mostly US ones),
// so common zones get their abbreviations from this table: [standard, daylight].

const S = (std: string, dst?: string) => (dst ? [std, dst] : [std]);

const CET = S('CET', 'CEST');
const EET = S('EET', 'EEST');
const WET = S('WET', 'WEST');
const AEST = S('AEST', 'AEDT');
const PST = S('PST', 'PDT');
const MST = S('MST', 'MDT');
const CST = S('CST', 'CDT');
const EST = S('EST', 'EDT');

const ZONE_ABBR: Record<string, string[]> = {
  UTC: S('UTC'),
  'Etc/UTC': S('UTC'),
  'Europe/London': S('GMT', 'BST'),
  'Europe/Dublin': S('GMT', 'IST'),
  'Europe/Lisbon': WET,
  'Atlantic/Canary': WET,
  'Atlantic/Reykjavik': S('GMT'),
  'Europe/Paris': CET,
  'Europe/Berlin': CET,
  'Europe/Madrid': CET,
  'Europe/Rome': CET,
  'Europe/Amsterdam': CET,
  'Europe/Brussels': CET,
  'Europe/Vienna': CET,
  'Europe/Zurich': CET,
  'Europe/Stockholm': CET,
  'Europe/Oslo': CET,
  'Europe/Copenhagen': CET,
  'Europe/Prague': CET,
  'Europe/Warsaw': CET,
  'Europe/Budapest': CET,
  'Europe/Belgrade': CET,
  'Europe/Luxembourg': CET,
  'Europe/Monaco': CET,
  'Europe/Malta': CET,
  'Europe/Athens': EET,
  'Europe/Helsinki': EET,
  'Europe/Kiev': EET,
  'Europe/Kyiv': EET,
  'Europe/Bucharest': EET,
  'Europe/Sofia': EET,
  'Europe/Riga': EET,
  'Europe/Tallinn': EET,
  'Europe/Vilnius': EET,
  'Asia/Nicosia': EET,
  'Africa/Cairo': EET,
  'Europe/Istanbul': S('TRT'),
  'Europe/Moscow': S('MSK'),
  'Europe/Minsk': S('MSK'),
  'Africa/Lagos': S('WAT'),
  'Africa/Johannesburg': S('SAST'),
  'Africa/Nairobi': S('EAT'),
  'Africa/Addis_Ababa': S('EAT'),
  'Asia/Jerusalem': S('IST', 'IDT'),
  'Asia/Dubai': S('GST'),
  'Asia/Muscat': S('GST'),
  'Asia/Riyadh': S('AST'),
  'Asia/Qatar': S('AST'),
  'Asia/Kuwait': S('AST'),
  'Asia/Baghdad': S('AST'),
  'Asia/Tehran': S('IRST'),
  'Asia/Kabul': S('AFT'),
  'Asia/Baku': S('AZT'),
  'Asia/Tbilisi': S('GET'),
  'Asia/Yerevan': S('AMT'),
  'Asia/Karachi': S('PKT'),
  'Asia/Tashkent': S('UZT'),
  'Asia/Yekaterinburg': S('YEKT'),
  'Asia/Kolkata': S('IST'),
  'Asia/Calcutta': S('IST'),
  'Asia/Colombo': S('SLST'),
  'Asia/Kathmandu': S('NPT'),
  'Asia/Katmandu': S('NPT'),
  'Asia/Dhaka': S('BST'),
  'Asia/Thimphu': S('BTT'),
  'Asia/Yangon': S('MMT'),
  'Asia/Rangoon': S('MMT'),
  'Asia/Bangkok': S('ICT'),
  'Asia/Ho_Chi_Minh': S('ICT'),
  'Asia/Saigon': S('ICT'),
  'Asia/Phnom_Penh': S('ICT'),
  'Asia/Vientiane': S('ICT'),
  'Asia/Novosibirsk': S('NOVT'),
  'Asia/Jakarta': S('WIB'),
  'Asia/Pontianak': S('WIB'),
  'Asia/Makassar': S('WITA'),
  'Asia/Jayapura': S('WIT'),
  'Asia/Kuala_Lumpur': S('MYT'),
  'Asia/Kuching': S('MYT'),
  'Asia/Singapore': S('SGT'),
  'Asia/Brunei': S('BNT'),
  'Asia/Manila': S('PHT'),
  'Asia/Hong_Kong': S('HKT'),
  'Asia/Macau': S('CST'),
  'Asia/Shanghai': S('CST'),
  'Asia/Taipei': S('CST'),
  'Asia/Ulaanbaatar': S('ULAT'),
  'Australia/Perth': S('AWST'),
  'Asia/Seoul': S('KST'),
  'Asia/Pyongyang': S('KST'),
  'Asia/Tokyo': S('JST'),
  'Pacific/Palau': S('PWT'),
  'Asia/Vladivostok': S('VLAT'),
  'Australia/Darwin': S('ACST'),
  'Australia/Adelaide': S('ACST', 'ACDT'),
  'Australia/Brisbane': S('AEST'),
  'Australia/Sydney': AEST,
  'Australia/Melbourne': AEST,
  'Australia/Hobart': AEST,
  'Australia/Canberra': AEST,
  'Pacific/Guam': S('ChST'),
  'Pacific/Port_Moresby': S('PGT'),
  'Pacific/Noumea': S('NCT'),
  'Pacific/Fiji': S('FJT'),
  'Pacific/Auckland': S('NZST', 'NZDT'),
  'Pacific/Tongatapu': S('TOT'),
  'Pacific/Apia': S('WST'),
  'Pacific/Honolulu': S('HST'),
  'Pacific/Tahiti': S('TAHT'),
  'America/Anchorage': S('AKST', 'AKDT'),
  'America/Los_Angeles': PST,
  'America/Vancouver': PST,
  'America/Tijuana': PST,
  'America/Denver': MST,
  'America/Edmonton': MST,
  'America/Boise': MST,
  'America/Phoenix': S('MST'),
  'America/Chicago': CST,
  'America/Winnipeg': CST,
  'America/Mexico_City': S('CST'),
  'America/Guatemala': S('CST'),
  'America/Costa_Rica': S('CST'),
  'America/Regina': S('CST'),
  'America/New_York': EST,
  'America/Toronto': EST,
  'America/Detroit': EST,
  'America/Montreal': EST,
  'America/Indiana/Indianapolis': EST,
  'America/Panama': S('EST'),
  'America/Jamaica': S('EST'),
  'America/Cancun': S('EST'),
  'America/Bogota': S('COT'),
  'America/Lima': S('PET'),
  'America/Havana': S('CST', 'CDT'),
  'America/Halifax': S('AST', 'ADT'),
  'America/Puerto_Rico': S('AST'),
  'America/Santo_Domingo': S('AST'),
  'America/Caracas': S('VET'),
  'America/La_Paz': S('BOT'),
  'America/Santiago': S('CLT', 'CLST'),
  'America/St_Johns': S('NST', 'NDT'),
  'America/Sao_Paulo': S('BRT'),
  'America/Argentina/Buenos_Aires': S('ART'),
  'America/Buenos_Aires': S('ART'),
  'America/Montevideo': S('UYT'),
  'Atlantic/Azores': S('AZOT', 'AZOST'),
};

/** Offsets (in minutes) for abbreviations people type after a date, like "10:00 PST". */
export const ABBR_OFFSET: Record<string, number> = {
  UTC: 0, GMT: 0, Z: 0, WET: 0, WEST: 60, BST: 60, CET: 60, CEST: 120, EET: 120, EEST: 180,
  MSK: 180, TRT: 180, WAT: 60, SAST: 120, EAT: 180, GST: 240, PKT: 300, IST: 330, NPT: 345,
  ICT: 420, WIB: 420, WITA: 480, WIT: 540, MYT: 480, SGT: 480, PHT: 480, HKT: 480, AWST: 480,
  JST: 540, KST: 540, ACST: 570, ACDT: 630, AEST: 600, AEDT: 660, NZST: 720, NZDT: 780,
  HST: -600, AKST: -540, AKDT: -480, PST: -480, PDT: -420, MST: -420, MDT: -360, CST: -360,
  CDT: -300, EST: -300, EDT: -240, AST: -240, ADT: -180, NST: -210, NDT: -150, BRT: -180, ART: -180,
};

/** Abbreviations that mean more than one thing; we pick the most common reading. */
export const AMBIGUOUS: Record<string, string> = {
  CST: 'US Central (UTC−06:00), not China Standard Time',
  IST: 'India (UTC+05:30), not Irish or Israel time',
  BST: 'British Summer Time (UTC+01:00), not Bangladesh',
  AST: 'Atlantic (UTC−04:00), not Arabia',
  GST: 'Gulf (UTC+04:00)',
};

type OffsetFn = (ms: number, tz: string) => number;

/** The abbreviation in force for a zone at an instant, e.g. MYT, PDT, CEST, or UTC+5 as a last resort. */
export function abbrFor(tz: string, ms: number, offsetMinutes: OffsetFn): string {
  const names = ZONE_ABBR[tz];
  const off = offsetMinutes(ms, tz);
  if (names) {
    if (names.length === 1) return names[0];
    const y = new Date(ms).getUTCFullYear();
    const jan = offsetMinutes(Date.UTC(y, 0, 1), tz);
    const jul = offsetMinutes(Date.UTC(y, 6, 1), tz);
    return off > Math.min(jan, jul) ? names[1] : names[0];
  }
  try {
    const name = new Intl.DateTimeFormat('en-US', { timeZone: tz, timeZoneName: 'short' })
      .formatToParts(new Date(ms))
      .find((p) => p.type === 'timeZoneName')?.value;
    if (name && /^[A-Z]{2,5}$/.test(name)) return name;
  } catch {
    /* fall through */
  }
  const h = Math.floor(Math.abs(off) / 60);
  const m = Math.abs(off) % 60;
  return `UTC${off < 0 ? '−' : '+'}${h}${m ? `:${String(m).padStart(2, '0')}` : ''}`;
}

/** Every abbreviation a zone uses, for search. */
export function abbrsOf(tz: string): string[] {
  return ZONE_ABBR[tz] ?? [];
}
