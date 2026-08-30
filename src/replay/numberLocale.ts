/**
 * Sprint 3 Task B: ExampleExchange's Telegram export formats numbers with a comma
 * decimal separator and a U+00A0 (non-breaking space) thousands separator
 * (confirmed by inspecting the raw bytes of a real export — a plain 0x20
 * space is NOT what's actually there), e.g. "1 778,05" -> 1778.05.
 */
export function parseLocaleNumber(raw: string): number {
  const normalized = raw.replace(/[\u0020\u00a0]/g, '').replace(',', '.');
  const value = Number(normalized);
  if (Number.isNaN(value)) {
    throw new Error(`parseLocaleNumber: '${raw}' is not a valid locale number`);
  }
  return value;
}
