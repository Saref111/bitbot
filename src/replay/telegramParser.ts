import { parseLocaleNumber } from './numberLocale.js';
import type { TelegramParseError, VelesEvent } from './types.js';

function assertNever(value: never): never {
  throw new Error(`telegramParser: unhandled event type: ${String(value)}`);
}

// Terminates every event block: "#d<dealId></a> | YYYY-MM-DD HH:MM:SS".
// Confirmed by direct inspection of a real export — fields/description for
// an event live BEFORE its own hashtag anchor, but dealId+timestamp live
// AFTER it, on the following line. So an event's data comes from the text
// BEHIND this terminator (back to the previous terminator), while its
// timestamp comes FROM this terminator itself — not the same direction.
const TERMINATOR_RE =
  /<a href="" onclick="return ShowHashtag\(&quot;d(\d+)&quot;\)">#d\d+<\/a>\s*\|\s*(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})/g;

const EVENT_MARKERS: readonly [VelesEvent['type'], string][] = [
  ['dealOpened', '#угодавідкрита'],
  ['firstOrderFilled', '#першийордер'],
  ['orderFilled', '#виконанийордер'],
  ['dealClosed', '#угодазакрита'],
];

const NUM = '[-\\d,\\u00a0 ]+';

function parseUtcTimestamp(raw: string): number {
  const match = /(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})/.exec(raw);
  if (!match) {
    throw new Error(`telegramParser: cannot parse timestamp '${raw}'`);
  }
  const [, y, mo, d, h, mi, s] = match;
  return Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s));
}

/** Tolerates each unit being absent — confirmed real durations exist both with seconds ("12h 58m 4s") and without ("1h 19m"). */
function parseDurationToMs(raw: string): number {
  const match = /^(?:(\d+)d\s*)?(?:(\d+)h\s*)?(?:(\d+)m\s*)?(?:(\d+)s)?\s*$/.exec(raw.trim());
  if (!match || match[0].trim().length === 0) {
    throw new Error(`telegramParser: cannot parse duration '${raw}'`);
  }
  const [, d, h, m, s] = match;
  return (
    Number(d ?? 0) * 86_400_000 +
    Number(h ?? 0) * 3_600_000 +
    Number(m ?? 0) * 60_000 +
    Number(s ?? 0) * 1_000
  );
}

function requireMatch(text: string, pattern: RegExp, description: string): RegExpExecArray {
  const match = pattern.exec(text);
  if (!match) {
    throw new Error(`telegramParser: could not find ${description} in event text`);
  }
  return match;
}

function buildEvent(
  type: VelesEvent['type'],
  dealId: string,
  timestamp: number,
  unitText: string,
): VelesEvent {
  switch (type) {
    case 'dealOpened':
      return { type, dealId, timestamp };

    case 'firstOrderFilled': {
      const m = requireMatch(unitText, /\((\d+)\s*\/\s*(\d+)\)/, 'rung counter "(k / N)"');
      return { type, dealId, timestamp, rung: Number(m[1]), rungTotal: Number(m[2]) };
    }

    case 'orderFilled': {
      const rungMatch = requireMatch(
        unitText,
        /Виконано\s+(\d+)\s+(?:із|з)\s+(\d+)\s+(?:доручень|ордерів)/,
        'rung counter "Виконано k із/з N доручень/ордерів"',
      );
      const sumMatch = requireMatch(unitText, new RegExp(`Сума:\\s*(${NUM})\\s*(\\w+)\\.`), '"Сума"');
      const notionalMatch = requireMatch(unitText, new RegExp(`Номінал:\\s*(${NUM})\\s*USDT`), '"Номінал"');
      const avgPriceMatch = requireMatch(
        unitText,
        new RegExp(`Середня ціна:\\s*(${NUM})\\s*USDT`),
        '"Середня ціна"',
      );
      return {
        type,
        dealId,
        timestamp,
        rung: Number(rungMatch[1]),
        rungTotal: Number(rungMatch[2]),
        sumBase: parseLocaleNumber(sumMatch[1] ?? ''),
        sumBaseAsset: sumMatch[2] ?? '',
        notionalUsdt: parseLocaleNumber(notionalMatch[1] ?? ''),
        avgPrice: parseLocaleNumber(avgPriceMatch[1] ?? ''),
      };
    }

    case 'dealClosed': {
      const rungMatch = requireMatch(
        unitText,
        /Виконано\s+(\d+)\s+(?:із|з)\s+(\d+)\s+(?:доручень|ордерів)/,
        'rung counter "Виконано k з/із N доручень/ордерів"',
      );
      const durationMatch = requireMatch(unitText, /Тривалість:\s*([^.]+)\./, '"Тривалість"');
      const profitMatch = requireMatch(
        unitText,
        new RegExp(`Дохід\\s*\\(USDT\\):\\s*(${NUM})`),
        '"Дохід (USDT)"',
      );
      const feeMatch = requireMatch(
        unitText,
        new RegExp(`Комісія біржі\\s*\\(USDT\\):\\s*(${NUM})`),
        '"Комісія біржі (USDT)"',
      );
      // Anchored to "Угода завершена за", not a bare "за\s+..." — every
      // message digest's preamble text ("Події за період:") also contains
      // the word "за", and unitText includes that whole preamble for a
      // dealClosed that happens to be the first event in its digest; a
      // bare "за" regex greedily matches THAT occurrence instead of the
      // real close-reason one. Also cuts before whichever comes first,
      // '(' or '.' — "за тейк-профітом (ETH/USDT)." would otherwise
      // capture "тейк-профітом (ETH/USDT)" if trimmed only at the first
      // '.', since that period is the one AFTER "(ETH/USDT)", not right
      // after the reason itself.
      const reasonMatch = requireMatch(
        unitText,
        /Угода завершена за\s+([^.(]+?)\s*[(.]/,
        'close reason "Угода завершена за ..."',
      );
      return {
        type,
        dealId,
        timestamp,
        filledRungs: Number(rungMatch[1]),
        rungTotal: Number(rungMatch[2]),
        durationMs: parseDurationToMs(durationMatch[1] ?? ''),
        profitUsdt: parseLocaleNumber(profitMatch[1] ?? ''),
        feeUsdt: parseLocaleNumber(feeMatch[1] ?? ''),
        closeReason: (reasonMatch[1] ?? '').trim(),
      };
    }

    default:
      return assertNever(type);
  }
}

/**
 * Sprint 3 Task B: extracts Veles' 4 event kinds from a Telegram Desktop
 * HTML export. Never throws — collects unparseable event blocks into
 * `errors` instead, so `events.length + errors.length` always equals the
 * number of dealId+timestamp terminators found, which is how "без тихих
 * помилок" (AC) is actually enforced: the caller can assert errors is
 * empty, rather than trusting a parser that might silently drop something.
 */
export function parseTelegramEvents(html: string): {
  events: VelesEvent[];
  errors: TelegramParseError[];
} {
  const events: VelesEvent[] = [];
  const errors: TelegramParseError[] = [];

  let lastIndex = 0;
  TERMINATOR_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = TERMINATOR_RE.exec(html)) !== null) {
    const unitText = html.slice(lastIndex, match.index);
    lastIndex = match.index + match[0].length;

    const dealId = match[1] ?? '';
    const timestampRaw = match[2] ?? '';

    const marker = EVENT_MARKERS.find(([, needle]) => unitText.includes(needle));
    if (!marker) {
      errors.push({ rawFragment: unitText, reason: 'no recognized event hashtag found in unit text' });
      continue;
    }

    try {
      const timestamp = parseUtcTimestamp(timestampRaw);
      events.push(buildEvent(marker[0], dealId, timestamp, unitText));
    } catch (error) {
      errors.push({ rawFragment: unitText, reason: error instanceof Error ? error.message : String(error) });
    }
  }

  return { events, errors };
}
