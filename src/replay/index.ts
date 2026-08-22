export {
  parseCandleCsvContent,
  parseCandleCsvFile,
  resolveCsvFilesForRange,
  loadCandles,
} from './candleCsvLoader.js';
export { checkAggregation } from './aggregationCheck.js';
export { parseLocaleNumber } from './numberLocale.js';
export { parseTelegramEvents } from './telegramParser.js';
export { checkTimezoneAlignment } from './tzSelfCheck.js';
export { findCandleByCloseTime } from './barCloseMapping.js';
export { replayWindow } from './replayWindow.js';
export { computeFilterVector } from './filterVector.js';
export { compareToGoldenVector, checkMultiplicity } from './goldenVectorCheck.js';
export { buildFilterDump } from './filterDump.js';
export type {
  CsvCandleSourceOptions,
  AggregationMismatch,
  AggregationCheckReport,
  TelegramParseError,
  VelesEvent,
  TzSelfCheckSample,
  TzSelfCheckReport,
  ReplayWindowParams,
  ReplayBarResult,
  ReplayResult,
  FilterChannelCount,
  FilterVector,
  GoldenVectorChannelDiff,
  GoldenVectorDiffReport,
  MultiplicityCheck,
  FilterDumpRow,
} from './types.js';
