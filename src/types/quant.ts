export type MarketRegime =
  | 'TRENDING_BULL'
  | 'TRENDING_BEAR'
  | 'HIGH_VOLATILITY_RANGE'
  | 'LOW_VOLATILITY_COMPRESSION';

export interface QuantitativeRegimeAssessment {
  market_regime: MarketRegime;
  key_drivers: [string, string] | string[];
  support_level: number;
  resistance_level: number;
  bias_probability_distribution: {
    bullish: number;
    bearish: number;
    neutral: number;
  };
  rationale: string;
}

export type StrategyArchetype = 'LONG_AND_LOW' | 'SHORT_AND_FAST';
export type ExecutionVenue = 'PUBLIC_BROKERAGE' | 'PREDICTION_MARKET';
export type AgentStatus = 'ACTIVE' | 'PAUSED' | 'HALTED_BY_KILL_SWITCH' | 'KILLED_BY_RISK';
export type IndicatorStrategyId =
  | 'BTC_LEAD_LAG_SNIPER'
  | 'HFT_15M_CLOB_MICRO_SCALPER'
  | 'HFT_15M_GAMMA_CONVERGENCE'
  | 'HFT_15M_VWAP_SNAPBACK'
  | 'EMA_VWAP_VELOCITY'
  | 'MACD_RVOL_MOMENTUM'
  | 'BB_SQUEEZE_BREAKOUT'
  | 'RSI_ATR_MEAN_REVERSION'
  | 'STOCH_RSI_OBV_SCALPER'
  | 'KALSHI_CLOB_IMBALANCE';

export interface LeadLagPaperTradeEntry {
  paperTradeId: string;
  ts: string;
  symbol: string;
  side: 'BUY_YES' | 'BUY_NO';
  contracts: number;
  makerLimitBidPrice: number;
  targetTakeProfitSellPrice: number;
  coinbaseSpot: number;
  strike: number;
  minutesLeft: number;
  nd2FairProb: number;
  mlCalibratedProb: number;
  ensembleProb: number;
  netEdgePerContract: number;
  paperRiskUsd: number;
  expectedPaperProfitUsd: number;
  status: 'PAPER_RESTING_MAKER' | 'PAPER_TP_HIT' | 'PAPER_SETTLED_WIN';
  rationale: string;
}

export interface LeadLagSignalEvaluation {
  ts: string;
  executionMode?: 'PAPER_SHADOW_CALIBRATION' | 'LIVE';
  coinbaseSpot: number;
  strike: number;
  minutesLeft: number;
  yesAsk: number;
  noAsk: number;
  annualVol: number;
  effectiveJumpAdjustedVol?: number;
  feePerContract: number;
  d2: number;
  nd2_fair_prob?: number;
  ml_calibrated_prob?: number;
  ensemble_prob?: number;
  fairYesProb: number;
  fairNoProb: number;
  yesNetEdge: number;
  noNetEdge: number;
  bestSide: 'BUY_YES' | 'BUY_NO';
  bestAsk: number;
  makerLimitBid?: number;
  netEdgePerContract: number;
  action: 'BUY_YES' | 'BUY_NO' | 'HOLD';
  sniper_action?: 'EXECUTE' | 'HOLD';
  gate_blocked_reason?: string;
  metaModelId?: string;
  metaModelTrained?: boolean;
  contracts: number;
  totalRiskUsd: number;
  feeGatePassed: boolean;
  edgeGatePassed: boolean;
  timeWindowGatePassed?: boolean;
  tweakedParamsSummary?: string;
  rationale: string;
}

export type McpCommercialTier =
  | 'FREE_DISCOVERY'
  | 'PRO_QUANT_SAAS'
  | 'AGENT_ORACLE_PAY_PER_CALL';

export interface McpLicenseKeySpec {
  licenseKey: string;
  tier: McpCommercialTier;
  label: string;
  rateLimitPerHour: number;
  requestsUsedThisHour: number;
  permittedMethods: string[];
  permittedTools: string[];
  pricingModel: string;
  x402MeteringConfig?: {
    protocol: 'x402-v1';
    httpStatusWhenUnpaid: 402;
    pricePerCallUsd: number;
    pricePerCallFet: number;
    stripeMeterEventName: string;
    fetSettlementAddress: string;
    paymentHeader: string;
  };
}

export interface MlTelemetryLedgerRow {
  timestamp_utc: string;
  symbol: string;
  venue: string;
  spot_price: number;
  coinbase_spot: number;
  strike: number;
  spot_to_strike_bps: number;
  minutes_left: number;
  yes_ask: number;
  no_ask: number;
  l2_imbalance: number;
  kalshi_spread_bps: number;
  nd2_fair_prob: number;
  ml_calibrated_prob?: number;
  ensemble_prob?: number;
  net_edge_dollars: number;
  atr_pct: number;
  atr_baseline_mult: number;
  rsi_14: number;
  ma_spread_short_pct: number;
  pearson_corr_regime: string;
  market_regime: MarketRegime;
  sniper_action: 'EXECUTE' | 'HOLD';
  gate_blocked_reason: string;
  realized_pnl_bps: number;
  realized_outcome: number | null;
}

export interface MlMetaModelState {
  is_trained: boolean;
  model_id: string;
  trained_at: string;
  engine: string;
  symbol_filter?: string;
  target_metric: string;
  samples_used: number;
  brier_score_raw: number;
  brier_score_calibrated: number;
  brier_score_ensemble?: number;
  brier_improvement_bps?: number;
  log_loss_calibrated: number;
  empirical_win_rate: number;
  avg_realized_pnl_bps?: number;
  recommended_min_net_edge: number;
  recommended_atr_stop_mult: number;
  recommended_ask_band: [number, number];
  weights: {
    intercept: number;
    nd2_fair_prob: number;
    atr_baseline_mult: number;
    rsi_14: number;
    ma_spread_short_pct: number;
    kalshi_spread_bps: number;
    minutes_left: number;
    l2_imbalance?: number;
  };
}

export interface MlFeatureStoreSnapshot {
  exportedAt: string;
  format: 'DUCKDB_PARQUET_JSON_MIRROR';
  tableName: 'ml_telemetry_ledger';
  rowCount: number;
  settledRowCount: number;
  totalRows?: number;
  settledRows?: number;
  trackedSymbols?: string[];
  activeMetaModel: MlMetaModelState;
  rows: MlTelemetryLedgerRow[];
}

export interface PlaybookCleanupAuditRow {
  ts: string;
  symbol: string;
  assetType: 'EQUITY' | 'EVENT';
  qty: number;
  currentValue: number;
  pnlPct: number;
  action: 'SWEEP_EQUITY_DUST (HIGHEST_COST LOT)' | 'TRIM_STALE_EVENT_CONTRACT' | 'KEEP_PROTECTED';
  estFee: number;
  netCashFreed: number;
  mode: 'LIVE' | 'DRY_RUN' | 'EXECUTED';
  swept?: boolean;
}

export interface OHLCVBar {
  timestamp: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  vwap: number;
}

export interface MarketFeatureVector {
  symbol: string;
  name: string;
  assetClass: 'EQUITY_ETF' | 'CRYPTO' | 'TREASURY_BOND' | 'PREDICTION_CONTRACT';
  venue: ExecutionVenue;
  price: number;
  change24hPct: number;
  volume24h: number;
  rvol: number; // Relative volume vs 20-period average
  vwap: number;
  vwapSpreadPct: number; // (price - vwap) / vwap * 100
  atr14: number;
  atrPct: number; // atr14 / price * 100
  atrBaselineMultiplier: number; // Current ATR vs 30-period baseline ATR (e.g. 1.0x normal, 2.8x spike)
  stdDev20: number;
  rsi14: number;
  ema9: number;
  ema21: number;
  sma50: number;
  sma200: number;
  maSpreadShortPct: number; // (ema9 - ema21) / ema21 * 100
  maSpreadLongPct: number; // (sma50 - sma200) / sma200 * 100
  predictionImpliedProb?: number; // 0.01 - 0.99 for prediction contracts or correlated macro probability
  orderbookImbalance: number; // -1.0 (heavy ask) to +1.0 (heavy bid)
  bidAskSpreadBps: number;
  newsSentimentScore: number; // -1.0 (bearish shock) to +1.0 (bullish catalyst)
  latestCatalystHeadline: string;
  bbPercentB?: number; // Bollinger Band %B (0.0 = lower band, 1.0 = upper band)
  bbBandwidthPct?: number; // Bollinger Band width %
  macdHistogram?: number; // MACD(12,26,9) histogram
  stochRsi?: number; // Stochastic RSI (0-100)
  dataSource?: string; // e.g. 'LIVE_PUBLIC_AND_EXCHANGE_BARS' | 'LIVE_KALSHI_CLOB_V2' | 'LIVE_KALSHI_15M_HFT_CLOB'
  is15MinPrediction?: boolean;
  seriesTicker?: string;
  activeContractTicker?: string;
  targetStrikeLabel?: string;
  closeTimeIso?: string;
  secondsToExpiry?: number;
  recentSettlements?: Array<'YES' | 'NO'>;
  tradesPerMinute?: number;
  leadLagSignal?: LeadLagSignalEvaluation;
  fetchedAt?: string;
  underlyingSpotSymbol?: string;
  underlyingSpotPrice?: number;
  underlyingRsi14?: number;
  underlyingAtrPct?: number;
  underlyingVwapSpreadPct?: number;
  bars: OHLCVBar[];
  lastAssessment?: QuantitativeRegimeAssessment;
}

export interface DataFeedSpec {
  id: string;
  name: string;
  provider: 'PUBLIC_API' | 'PREDICTION_CLOB' | 'QUANT_NEWS_MACRO' | 'DERIVED_TECH_ENGINE';
  endpointPattern: string;
  cadence: string;
  latencyMs: number;
  targetArchetype: 'LONG_AND_LOW' | 'SHORT_AND_FAST' | 'BOTH';
  category: 'MARKET_DATA' | 'TECHNICAL_INDICATOR' | 'ORDERBOOK_LIQUIDITY' | 'SENTIMENT_MACRO';
  description: string;
  keyFields: string[];
  riskMitigationRole: string;
  enabled: boolean;
}

export type ExitEvaluationResultStatus =
  | 'EVALUATED_NO_ACTION'
  | 'TRIGGERED_TAKE_PROFIT'
  | 'TRIGGERED_STOP_LOSS'
  | 'TRIGGERED_PROFIT_LOCK'
  | 'TRIGGERED_EXPIRATION_FLATTEN'
  | 'TRIGGERED_EXPIRATION_CLIFF'
  | 'EXIT_VENUE_REJECTED';

export interface ExecutedOrder {
  id: string;
  idempotencyKey?: string;
  timestamp: string;
  agentId: string;
  agentName: string;
  symbol: string;
  venue: ExecutionVenue;
  side: 'BUY' | 'SELL' | 'BUY_YES' | 'BUY_NO' | 'SELL_YES' | 'SELL_NO';
  orderType: 'LIMIT_OCO' | 'MARKET_IOC' | 'STOP_LOSS_EXIT';
  quantity: number;
  fillPrice: number;
  notionalUsd?: number;
  stopLossPrice: number;
  takeProfitPrice: number;
  regimeAtEntry: MarketRegime;
  status: 'FILLED' | 'WORKING_OCO' | 'CANCELLED_BY_KILL_SWITCH';
  rationale: string;
  lastExitEvaluatedAt?: string;
  lastExitEvaluationResult?: ExitEvaluationResultStatus;
  lastEvaluatedPrice?: number;
}

export interface AutonomousAgent {
  id: string;
  name: string;
  archetype: StrategyArchetype;
  venue: ExecutionVenue;
  targetSymbol: string;
  underlyingFeatureSymbol?: string;
  modelId?: string;
  timeframe: '1m' | '5m' | '15m' | '4H' | '1D' | '1W';
  status: AgentStatus;
  allocatedCapitalUsd?: number;
  kalshiAllocatedUsd?: number;
  publicAllocatedUsd?: number;
  indicatorStrategyId?: IndicatorStrategyId;
  indicatorStrategyLabel?: string;
  subscribedFeeds: string[];
  entryRules: {
    requiredRegimes: MarketRegime[];
    rsiRange: [number, number];
    minOrderbookImbalance: number;
    maAlignment: string;
  };
  riskGovernance: {
    maxDrawdownLimitPct: number;
    currentDrawdownPct: number;
    atrSpikeKillMultiplier: number;
    stopLossAtrMultiple: number;
    takeProfitAtrMultiple: number;
    maxPositionNotionalUsd: number;
  };
  metrics: {
    allocatedCapitalUsd: number;
    unrealizedPnlUsd: number;
    realizedPnlUsd: number;
    winRatePct: number;
    tradesExecuted: number;
    sharpeRatio: number;
  };
  selfLearningState?: {
    brierScore: number;
    netFeeAdjustedEdgeCents: number;
    settledSampleCount: number;
    autoTunedMinEdgeCents: number;
    autoTunedMaxContracts: number;
    banditStatus: 'PROMOTED_LIVE' | 'ACTIVE_ROTATION' | 'EXPLORATION_CAP';
    atrBaselineMultiplier?: number;
    volatilityRegimeWeight?: number;
    volatilityRegimeBand?: 'OPTIMAL_1.0X_1.5X_GOLDILOCKS' | 'LOW_COMPRESSION_SUB_1.0X' | 'HIGH_NOISE_ABOVE_1.5X_THROTTLED';
    rawUcbScore?: number;
    ucbScore?: number;
    allocationSharePct?: number;
    promotedStrategyId?: IndicatorStrategyId;
    promotedStrategyLabel?: string;
    walkForwardSharpe?: number;
    walkForwardWinRatePct?: number;
    contractSizing5x?: number;
    lastCalibratedAt: string;
  };
  liveGateStatus?:
    | 'ORDER_ROUTED'
    | 'RESTING_MAKER_ORDER'
    | 'OPEN_POSITION_ACTIVE'
    | 'REQUOTED_STALE_90S'
    | 'READY_IN_WINDOW'
    | 'WAITING_FOR_WINDOW'
    | 'WAITING_FOR_EDGE'
    | 'SPREAD_OR_VOL_GUARD'
    | 'BANDIT_THROTTLED'
    | 'STANDBY';
  liveGateDetail?: string;
  killSwitchReason?: string;
  lastEvaluatedAt: string;
}

export interface PublicApiPosition {
  symbol: string;
  name: string;
  quantity: number;
  averagePrice: number;
  currentPrice: number;
  marketValue: number;
  unrealizedPnl: number;
  gainPercentage: number;
  dailyGainUsd: number;
  percentOfPortfolio: number;
  instrumentType: string;
  openedAt?: string;
  stopLossPrice?: number;
  takeProfitPrice?: number;
  lastExitEvaluatedAt?: string;
  lastExitEvaluationResult?: ExitEvaluationResultStatus;
  lastEvaluatedPrice?: number;
}

export interface PublicApiOrder {
  orderId: string;
  symbol: string;
  instrumentType: string;
  side: string;
  type: string;
  status: string;
  quantity: number;
  stopPrice: number | null;
  limitPrice: number | null;
  timeInForce: string;
  createdAt: string;
}

export interface KalshiBalanceBreakdown {
  exchangeIndex: number;
  balanceUsd: number;
}

export interface KalshiPosition {
  ticker: string;
  title: string;
  side: 'YES' | 'NO';
  contracts: number;
  rawPositionFp: number;
  marketExposureUsd: number;
  currentPrice: number;
  yesPrice: number;
  currentValueUsd: number;
  unrealizedPnlUsd: number;
  realizedPnlUsd: number;
  feesPaidUsd: number;
  totalTradedUsd: number;
  lastUpdatedTs: string;
  stopLossPrice?: number;
  takeProfitPrice?: number;
  lastExitEvaluatedAt?: string;
  lastExitEvaluationResult?: ExitEvaluationResultStatus;
  lastEvaluatedPrice?: number;
}

export interface KalshiFill {
  fillId: string;
  orderId: string;
  ticker: string;
  action: 'buy' | 'sell';
  side: 'yes' | 'no';
  count: number;
  yesPrice: number;
  noPrice: number;
  feeCostUsd: number;
  isTaker: boolean;
  createdTime: string;
}

export interface McpToolDefinition {
  name: string;
  description: string;
  category:
    | 'KALSHI_PORTFOLIO'
    | 'PUBLIC_BROKERAGE'
    | 'QUANT_REGIME'
    | 'ALPHA_BACKTEST'
    | 'ORDER_EXECUTION'
    | 'RISK_GOVERNANCE'
    | 'DLQ_FALLBACK'
    | 'ML_META_OPTIMIZER';
  isAsync?: boolean;
  isMutating?: boolean;
  requiresIdempotencyKey?: boolean;
  inputSchema: Record<string, any>;
}

export interface McpPromptDefinition {
  name: string;
  description: string;
  decoratorSignature: string;
  arguments: Array<{
    name: string;
    description: string;
    required: boolean;
    defaultValue?: string | number;
  }>;
  templatePreview: string;
}

export interface McpDlqEntry {
  dlqId: string;
  idempotencyKey: string;
  failedTool: string;
  payloadJson: string;
  errorReason: string;
  severity: 'CRITICAL' | 'WARNING';
  status: 'QUARANTINED_HOLD' | 'REPLAYED' | 'DISMISSED';
  createdAt: string;
  dataQualityWarning: boolean;
  rationale: string;
}

export interface McpIdempotencyRecord {
  idempotencyKey: string;
  toolName: string;
  payloadHash: string;
  executedAt: string;
  replayCount: number;
  responsePreview: string;
}

export interface McpResourceDefinition {
  uri: string;
  name: string;
  description: string;
  mimeType: string;
}

export interface McpServerConnection {
  id: string;
  name: string;
  transport: 'http' | 'HTTP_JSON_RPC' | 'SSE_STREAM' | 'STDIO_BRIDGE';
  statelessHttp?: boolean;
  endpointUrl: string;
  protocolVersion: string;
  status: 'CONNECTED' | 'DEGRADED' | 'DISCONNECTED';
  latencyMs: number;
  authType: string;
  toolsCount: number;
  resourcesCount: number;
  promptsCount?: number;
  lastPingAt: string;
  capabilities: string[];
}

export interface McpCallLogEntry {
  id: string;
  timestamp: string;
  serverId: string;
  method: string;
  toolOrResourceName: string;
  idempotencyKey?: string;
  idempotentReplay?: boolean;
  dlqRouted?: boolean;
  args: Record<string, any>;
  durationMs: number;
  status: 'SUCCESS' | 'ERROR' | 'DLQ_FALLBACK';
  responsePreview: string;
  rawJsonRpcResponse?: Record<string, any>;
}

export interface PortfolioSummary {
  accountId: string;
  accountType: string;
  connectionMode: 'LIVE_PUBLIC_API' | 'SYNCHRONIZED_PROXY_SIMULATION';
  publicApiConfigured: boolean;
  publicApiConnected: boolean;
  publicSecretEnvName?: string;
  publicLastSyncStatus: string;
  publicPositions: PublicApiPosition[];
  publicOrders: PublicApiOrder[];
  predictionApiConfigured: boolean;
  kalshiApiConfigured?: boolean;
  kalshiApiConnected?: boolean;
  kalshiAuthMethod?: string;
  kalshiKeyIdPreview?: string;
  kalshiLastSyncStatus?: string;
  kalshiCashBalanceUsd?: number;
  kalshiPortfolioValueUsd?: number;
  kalshiTotalEquityUsd?: number;
  kalshiBalanceBreakdown?: KalshiBalanceBreakdown[];
  kalshiPositions?: KalshiPosition[];
  kalshiRecentFills?: KalshiFill[];
  combinedMultiVenueEquityUsd?: number;
  mcpConnected?: boolean;
  mcpServerCount?: number;
  mcpToolCount?: number;
  totalEquityUsd: number;
  buyingPowerUsd: number;
  cashOnlyBuyingPowerUsd: number;
  optionsBuyingPowerUsd: number;
  cashBalanceUsd: number;
  stockEquityUsd: number;
  eventContractsEquityUsd: number;
  allocatedToLongAndLowUsd: number;
  allocatedToShortAndFastUsd: number;
  dailyPnlUsd: number;
  dailyPnlPct: number;
  portfolioDrawdownPct: number;
  globalKillSwitchActive: boolean;
  lastSyncTimestamp: string;
}

export interface AlphaOpportunity {
  symbol: string;
  name: string;
  venue: ExecutionVenue;
  assetClass: MarketFeatureVector['assetClass'];
  price: number;
  recommendedArchetype: StrategyArchetype;
  detectedRegime: MarketRegime;
  alphaScore: number; // 0 to 100 composite deterministic alpha score
  expectedEdgeBps: number; // Expected return edge in basis points
  signalCatalyst: string;
  keyMetrics: {
    atrPct: number;
    atrBaselineMultiplier: number;
    rsi14: number;
    maSpreadShortPct: number;
    maSpreadLongPct: number;
    vwapSpreadPct: number;
    rvol: number;
    orderbookImbalance: number;
  };
  suggestedStopLoss: number;
  suggestedTakeProfit: number;
}

export interface BacktestTrade {
  id: string;
  entryTimestamp: string;
  exitTimestamp: string;
  side: 'LONG' | 'SHORT';
  entryPrice: number;
  exitPrice: number;
  quantity: number;
  pnlUsd: number;
  returnPct: number;
  exitReason: 'TAKE_PROFIT_OCO' | 'STOP_LOSS_OCO' | 'REGIME_REVERSAL_EXIT' | 'ATR_CIRCUIT_BREAKER';
  regimeAtEntry: MarketRegime;
}

export interface BacktestEquityPoint {
  timestamp: string;
  barIndex: number;
  strategyEquity: number;
  benchmarkEquity: number;
  drawdownPct: number;
  underlyingPrice: number;
}

export interface BacktestResult {
  symbol: string;
  archetype: StrategyArchetype;
  indicatorStrategyId?: IndicatorStrategyId;
  indicatorStrategyLabel?: string;
  dataSource?: string;
  barsTested: number;
  initialCapitalUsd: number;
  finalEquityUsd: number;
  benchmarkFinalEquityUsd: number;
  totalReturnPct: number;
  benchmarkReturnPct: number;
  netAlphaPct: number;
  sharpeRatio: number;
  sortinoRatio: number;
  profitFactor: number;
  winRatePct: number;
  maxDrawdownPct: number;
  totalTrades: number;
  circuitBreakerSaves: number;
  parameters: {
    rsiEntryLow: number;
    rsiEntryHigh: number;
    stopLossAtrMultiple: number;
    takeProfitAtrMultiple: number;
    atrKillMultiplier: number;
  };
  equityCurve: BacktestEquityPoint[];
  trades: BacktestTrade[];
}

export interface ComparativeEquityPoint {
  timestamp: string;
  barIndex: number;
  strategyAEquity: number;
  strategyBEquity: number;
  benchmarkEquity: number;
  strategyADrawdownPct: number;
  strategyBDrawdownPct: number;
  equitySpreadUsd: number;
  underlyingPrice: number;
}

export interface ComparativeBacktestResult {
  symbol: string;
  detectedRegime: MarketRegime;
  barsTested: number;
  initialCapitalUsd: number;
  dataSource: string;
  dataQualityWarning: boolean;
  strategyA: BacktestResult;
  strategyB: BacktestResult;
  winnerStrategyId: IndicatorStrategyId;
  winnerStrategyLabel: string;
  winnerSlot: 'STRATEGY_A' | 'STRATEGY_B';
  deltas: {
    totalReturnSpreadPct: number;
    netAlphaSpreadPct: number;
    sharpeSpread: number;
    sortinoSpread: number;
    maxDrawdownSpreadPct: number;
    winRateSpreadPct: number;
    profitFactorSpread: number;
  };
  riskFirstVerdict: {
    downsideWinnerId: IndicatorStrategyId;
    riskAdjustedWinnerId: IndicatorStrategyId;
    invalidationThresholdAtr: number;
    maxAllowedDrawdownPct: number;
    rationale: string;
  };
  equityCurve: ComparativeEquityPoint[];
}


export interface StrategyTournamentEntry {
  rank: number;
  symbol: string;
  name: string;
  venue: ExecutionVenue;
  archetype: StrategyArchetype;
  indicatorStrategyId: IndicatorStrategyId;
  indicatorStrategyLabel: string;
  indicatorSignalFormula: string;
  barsTested: number;
  dataSource: string;
  totalReturnPct: number;
  benchmarkReturnPct: number;
  netAlphaPct: number;
  sharpeRatio: number;
  winRatePct: number;
  profitFactor: number;
  maxDrawdownPct: number;
  totalTrades: number;
  recommendedStopAtr: number;
  recommendedTakeProfitAtr: number;
  compositeScore: number;
  is15MinPrediction?: boolean;
  activeContractTicker?: string;
  targetStrikeLabel?: string;
}

export type RiskEventType =
  | 'ATR_SPIKE_HALT'
  | 'MAX_DRAWDOWN_BREACH'
  | 'GLOBAL_KILL_SWITCH'
  | 'SPREAD_LIQUIDITY_GUARD'
  | 'CIRCUIT_BREAKER_RESET'
  | 'GLOBAL_PROFIT_LOCK_STEPDOWN'
  | 'REALTIME_ROI_AUTO_EXIT';

export interface RiskEventNotification {
  id: string;
  timestamp: string;
  eventType: RiskEventType;
  severity: 'CRITICAL' | 'WARNING' | 'RESOLVED';
  agentId: string;
  agentName: string;
  archetype: StrategyArchetype;
  symbol: string;
  venue: ExecutionVenue;
  triggerMetric: string;
  thresholdValue: string;
  observedValue: string;
  actionTaken: string;
  cancelledOrderIds: string[];
  acknowledged: boolean;
}

export interface AppSourceFileEntry {
  path: string;
  sizeBytes: number;
  sha256: string;
  category: 'BACKEND' | 'FRONTEND' | 'CONFIG' | 'PLAYBOOK_VAULT';
  content: string;
}

export interface AppBundleExportPayload {
  bundleId: string;
  exportedAt: string;
  appName: string;
  version: string;
  dataQualityWarning: boolean;
  riskFirstEvaluation: {
    portfolioDrawdownPct: number;
    maxAllowedDrawdownPct: number;
    globalKillSwitchActive: boolean;
    activeCircuitBreakerAlerts: number;
    invalidationThresholdAtr: number;
    rationale: string;
  };
  summaryMetrics: {
    totalSourceFiles: number;
    totalBundleBytes: number;
    trackedInstrumentsCount: number;
    activeAgentsCount: number;
    workingOrdersCount: number;
    combinedMultiVenueEquityUsd: number;
  };
  liveState: {
    portfolio: PortfolioSummary;
    feeds: DataFeedSpec[];
    features: MarketFeatureVector[];
    agents: AutonomousAgent[];
    orders: ExecutedOrder[];
    riskEvents: RiskEventNotification[];
    strategyTournament: StrategyTournamentEntry[];
    playbookCleanupAudit: PlaybookCleanupAuditRow[];
    mlFeatureStore?: MlFeatureStoreSnapshot;
  };
  mlFeatureStore?: MlFeatureStoreSnapshot;
  deepDive15mPackage?: DeepDive15mPostMortemPackage;
  sourceFiles: AppSourceFileEntry[];
  playbookMarkdownReport: string;
}

export interface DeepDive15mPostMortemPackage {
  packageId: string;
  generatedAt: string;
  title: string;
  executiveSummary: string;
  postMortemRootCauses: Array<{
    id: string;
    failureMode: string;
    whatHappenedIn15mCycle: string;
    telemetryEvidence: string;
    quantitativeFixImplemented: string;
    expectedEdgeRecoveryBps: number;
  }>;
  profitVaultAndMarketSellRules: {
    immediateProfitVaultSweepPct: number;
    reinvestableFloatPct: number;
    lockedProfitVaultUsd: number;
    reinvestableWorkingProfitUsd: number;
    allowMarketSellExits: boolean;
    scaleOut75PctOnFirstTarget: boolean;
    max15mCycleDrawdownStopUsd: number;
    maxContractsPerScalpTranche: number;
    multiScalpInOutTurnovers: number;
    mathematicalFormula: string;
  };
  intraCycleMultiScalpPlaybook: Array<{
    windowPhase: string;
    minutesRemainingBand: string;
    entryRule: string;
    exitRule: string;
    profitVaultAction: string;
  }>;
  livePortfolioAndVenueSnapshot: {
    combinedMultiVenueEquityUsd: number;
    kalshiCashBalanceUsd: number;
    kalshiPortfolioValueUsd: number;
    kalshiTotalEquityUsd: number;
    publicTotalEquityUsd: number;
    openKalshiPositionsCount: number;
    restingSellOrdersCount: number;
    recentKalshiFillsCount: number;
  };
  deepDiveModelPromptTemplate: string;
  deepDiveMarkdownReport: string;
}

export interface DriveCopiedArtifact {
  id: string;
  name: string;
  mimeType: string;
  sizeBytes: number;
  webViewLink: string;
  createdTime: string;
}

export interface DriveAppCopyFolder {
  id: string;
  name: string;
  createdTime: string;
  modifiedTime?: string;
  webViewLink: string;
  description?: string;
  files?: DriveCopiedArtifact[];
}

export interface KalshiRestingSellOrder {
  orderId: string;
  ticker: string;
  title: string;
  side: 'SELL_YES' | 'SELL_NO';
  contracts: number;
  entryPrice: number;
  targetSellPrice: number;
  expectedProfitUsd: number;
  exchangeStatus: string;
  placedAt: string;
}

export interface PrecursorLeadUpPhrase {
  phrase: string;
  transitionProbPct: number;
  avgLeadTimeMs: number;
  syntacticRole: string;
}

export interface VisemeLipReadSignature {
  ipaPhonemes: string;
  visemeSequence: string[];
  mouthArticulationSummary: string;
  visualLeadAdvantageMs: number;
  confidenceScorePct: number;
}

export interface MentionTargetWordContract {
  id: string;
  targetWord: string;
  kalshiTicker: string;
  category: string;
  yesBid: number;
  yesAsk: number;
  noAsk: number;
  independentModelProb: number;
  netEdgeCents: number;
  isLongshotTrapBelow10c: boolean;
  historicalMentionBaseRatePct: number;
  precursorPhrases: PrecursorLeadUpPhrase[];
  lipReadSignature: VisemeLipReadSignature;
  recommendedAction: 'SNIPE_BUY_YES_AND_AUTO_SELL' | 'SNIPE_BUY_NO_AND_AUTO_SELL' | 'POST_ONLY_MAKER_BID' | 'AVOID_LONGSHOT_BIAS';
  targetTakeProfitSellPrice: number;
}

export interface SpeakerDeepDiveProfile {
  speakerId: string;
  speakerName: string;
  eventTitle: string;
  eventSeriesTicker: string;
  scheduledTimeLabel: string;
  corpusSpeechesAnalyzed: number;
  avgWordsPerMinute: number;
  rhetoricalCadenceSummary: string;
  acousticToVisualLatencyAdvantageMs: number;
  contracts: MentionTargetWordContract[];
}

export interface CombinatorialArbitrageBundle {
  bundleId: string;
  title: string;
  relationshipType: 'MUTUALLY_EXCLUSIVE_SUM_OVER_100C' | 'LOGICAL_IMPLICATION_SUBSET_VIOLATION' | 'CROSS_PLATFORM_KALSHI_POLYMARKET';
  legs: Array<{
    ticker: string;
    venue: 'KALSHI_CLOB_V2' | 'PUBLIC_EVENTCONTRACT' | 'POLYMARKET_CLOB';
    outcomeLabel: string;
    action: 'BUY_NO' | 'BUY_YES' | 'SELL_YES';
    executablePrice: number;
  }>;
  sumImpliedProbCents: number;
  guaranteedPayoutCents: number;
  totalCostAfterFeesCents: number;
  lockedArbitrageProfitPct: number;
  historicalPersistenceMinutes: number;
  rationale: string;
}

export interface PredictionStrategy2026Card {
  id:
    | 'COMBINATORIAL_ARBITRAGE'
    | 'MARKET_MAKING_LIQUIDITY_REWARDS'
    | 'INDEPENDENT_PROBABILITY_FORECASTING'
    | 'CROSS_PLATFORM_ARBITRAGE'
    | 'SPECIALIST_WALLET_TRACKING'
    | 'EVENT_DRIVEN_MENTION_LIPREAD_SNIPER';
  rank: number;
  title: string;
  tag: string;
  edgeMetricLabel: string;
  edgeMetricValue: string;
  coreMechanism: string;
  october2026ResearchFinding: string;
  bestDataRequired: string[];
  liveImplementationStatus: 'ACTIVE_AUTO_ROUTING' | 'SCANNING_LIVE_CLOB' | 'GUARDRAIL_ENFORCED';
}

export interface MentionSniperState {
  updatedAt: string;
  autoSellEnabled: boolean;
  defaultTakeProfitDeltaCents: number;
  activeRestingSellOrders: KalshiRestingSellOrder[];
  selectedSpeakerId: string;
  speakers: SpeakerDeepDiveProfile[];
  combinatorialArbBundles: CombinatorialArbitrageBundle[];
  strategies2026: PredictionStrategy2026Card[];
  recentLipReadTriggers: Array<{
    id: string;
    timestamp: string;
    speakerName: string;
    detectedStreamText: string;
    matchedPrecursorOrViseme: string;
    targetWord: string;
    kalshiTicker: string;
    leadTimeAdvantageMs: number;
    convictionPct: number;
    buyOrderId: string;
    buyPrice: number;
    restingSellOrderId: string;
    targetSellPrice: number;
    status: string;
  }>;
}

export type BottleneckPipelineStageId =
  | 'FEED_INGESTION'
  | 'FEATURE_AND_ML_INFERENCE'
  | 'RISK_AND_IDEMPOTENCY_GATE'
  | 'VENUE_SIGNING_AND_ROUTING'
  | 'CLOB_MATCHING_AND_ACK';

export interface BottleneckStageBreakdown {
  feedIngestionMs: number;
  featureAndMlInferenceMs: number;
  riskAndIdempotencyGateMs: number;
  venueSigningAndRoutingMs: number;
  clobMatchingAndAckMs: number;
}

export interface AgentTriggerToOrderTrace {
  traceId: string;
  agentId: string;
  agentName: string;
  symbol: string;
  venue: ExecutionVenue;
  orderId: string;
  side: string;
  triggerTimestamp: string;
  executionTimestamp: string;
  totalTriggerToExecMs: number;
  stages: BottleneckStageBreakdown;
  dominantStage: BottleneckPipelineStageId;
  convictionTier: 'HIGH' | 'MODERATE' | 'LOW';
  slippageBps: number;
}

export interface AgentBottleneckProfile {
  agentId: string;
  agentName: string;
  targetSymbol: string;
  venue: ExecutionVenue;
  archetype: StrategyArchetype;
  indicatorStrategyId: string;
  indicatorStrategyLabel: string;
  status: AgentStatus;
  sampleCount: number;
  meanTriggerToExecMs: number;
  p50LatencyMs: number;
  p95LatencyMs: number;
  p99LatencyMs: number;
  maxSpikeMs: number;
  highConvictionSlaMs: number;
  slaCompliancePct: number;
  primaryBottleneckStage: BottleneckPipelineStageId;
  primaryBottleneckReason: string;
  recommendedMitigation: string;
  estimatedEdgeDecayBps: number;
  stageAverages: BottleneckStageBreakdown;
  recentTraces: AgentTriggerToOrderTrace[];
}

export interface PerformanceBottleneckSnapshot {
  evaluatedAt: string;
  optimizationApplied: boolean;
  fleetMeanTriggerToExecMs: number;
  fleetP95LatencyMs: number;
  fleetP99LatencyMs: number;
  highConvictionCeilingMs: number;
  moderateConvictionCeilingMs: number;
  fleetSlaCompliancePct: number;
  dominantFleetBottleneckStage: BottleneckPipelineStageId;
  totalTracesAnalyzed: number;
  agentProfiles: AgentBottleneckProfile[];
}

export interface ProfitLockAdjustmentEvent {
  id: string;
  timestamp: string;
  triggerType:
    | 'REALTIME_ROI_THRESHOLD_SELL'
    | 'GLOBAL_PROFIT_LOCK_OCO_STEPDOWN'
    | 'PROFIT_VAULT_75PCT_SWEEP'
    | 'MARKET_IOC_PROFIT_HARVEST'
    | 'EXPIRATION_CLIFF_FLATTEN';
  symbol: string;
  venue: ExecutionVenue;
  orderId: string;
  entryPrice: number;
  observedPrice: number;
  peakHighWaterMarkPrice: number;
  observedRoiPct: number;
  previousTakeProfitPrice: number;
  adjustedTakeProfitPrice: number;
  stepDownPctApplied: number;
  lockedProfitVaultDeltaUsd?: number;
  rationale: string;
}

export interface GlobalProfitLockState {
  realTimeRoiTriggerEnabled: boolean;
  realTimeRoiTriggerPct: number;
  globalProfitLockEnabled: boolean;
  trailingStopThresholdPct: number;
  ocoTakeProfitStepDownPct: number;
  profitVaultAllocationPct: number;
  lockedProfitVaultUsd: number;
  reinvestableWorkingProfitUsd: number;
  allowMarketSellExits: boolean;
  scaleOut75PctOnFirstTarget: boolean;
  max15mCycleDrawdownStopUsd: number;
  multiScalpInOutTurnovers: number;
  totalRoiAutoSellsExecuted: number;
  totalProfitLockStepDowns: number;
  lastEvaluatedAt: string;
  recentEvents: ProfitLockAdjustmentEvent[];
}

export interface PromotedSeriesBacktestWinner {
  seriesTicker: string;
  underlyingSpotSymbol: string;
  strategyId: IndicatorStrategyId;
  strategyLabel: string;
  sharpeRatio: number;
  winRatePct: number;
  profitFactor: number;
  totalReturnPct: number;
  totalTrades: number;
  contractsPerOrder5x: number;
  evaluatedAt: string;
}

export interface CloudDaemonGateDiagnostic {
  seriesTicker: string;
  activeContractTicker: string;
  underlyingSpotSymbol: string;
  underlyingSpotPrice: number;
  minsRemaining: number;
  yesBidDollars: number;
  yesAskDollars: number;
  noAskDollars: number;
  spreadCents: number;
  blendedRsi14: number;
  vwapSpreadPct: number;
  orderbookImbalance: number;
  bestEdgeCents: number;
  requiredMinEdgeCents: number;
  promotedStrategyId?: IndicatorStrategyId;
  promotedStrategyLabel?: string;
  walkForwardSharpe?: number;
  walkForwardWinRatePct?: number;
  contractSizing5x?: number;
  gateStatus:
    | 'ORDER_ROUTED'
    | 'RESTING_MAKER_ORDER'
    | 'OPEN_POSITION_ACTIVE'
    | 'REQUOTED_STALE_90S'
    | 'READY_IN_WINDOW'
    | 'WAITING_FOR_WINDOW'
    | 'WAITING_FOR_EDGE'
    | 'SPREAD_OR_VOL_GUARD'
    | 'BANDIT_THROTTLED';
  gateDetail: string;
  evaluatedAt: string;
}

export interface CloudDaemonTelemetry {
  daemonActive: boolean;
  cycleIntervalSec: number;
  entryWindowMins: [number, number];
  maxSpreadCents: number;
  staleMakerRecycleSec: number;
  totalPulsesRun: number;
  totalOrdersRoutedByDaemon: number;
  staleMakerOrdersRecycled: number;
  lastHeartbeatAt: string;
  lastDataSyncAt: string;
  firestoreLastSyncedAt: string | null;
  firestoreRestoredAt?: string | null;
  firestoreDatabaseId: string;
  keepAliveSelfPings?: number;
  lastSelfPingAt?: string | null;
  settlementsBackfilledCount?: number;
  lastRebacktestAt?: string | null;
  contractSizingMultiplier?: number;
  cronWebhookPath?: string;
  seriesWinners?: PromotedSeriesBacktestWinner[];
  recentRecycledOrders: Array<{
    orderId: string;
    ticker: string;
    ageSec: number;
    recycledAt: string;
    reason: string;
  }>;
  gateDiagnostics: CloudDaemonGateDiagnostic[];
}

export type OrchestratorConvictionTier = 'HIGH' | 'MODERATE' | 'LOW' | 'ABORTED';
export type OrchestratorRiskStatus = 'NOMINAL' | 'ELEVATED' | 'CRITICAL_BREACH';
export type OrchestratorExecutionMode = 'TAKER_LIMIT' | 'MAKER_POST_ONLY' | 'NONE' | 'RISK_MITIGATION';

export interface OrchestratorMcpToolInvocation {
  tool_name: string;
  latency_ms: number;
  phase?: 'PHASE_1_INIT' | 'PHASE_2_EVAL' | 'PHASE_3_EXEC' | 'CIRCUIT_BREAKER_DLQ';
  cached?: boolean;
  retry_count?: number;
}

export interface OrchestratorOutputContract {
  evaluation_timestamp: string;
  conviction_tier: OrchestratorConvictionTier;
  risk_status: OrchestratorRiskStatus;
  dataQualityWarning: boolean;
  net_edge_bps: number;
  execution_mode: OrchestratorExecutionMode;
  mcp_tools_invoked: OrchestratorMcpToolInvocation[];
  rationale: string;
  recommended_action: string;
}

export interface PostgresPortfolioPositionRow {
  position_id: string;
  venue: 'COINBASE' | 'KALSHI' | 'POLYMARKET';
  ticker: string;
  net_exposure_usd: number;
  unrealized_pnl_bps: number;
  updated_at: string;
}

export interface PostgresMarketSignalRow {
  signal_id: string;
  asset_pair: string;
  implied_prob_delta: number;
  orderbook_imbalance_ratio: number;
  volatility_regime: string;
  captured_at: string;
}

export interface HalfKellySizingBreakdown {
  p_true: number;
  p_eff: number;
  raw_kelly_fraction: number;
  half_kelly_fraction: number;
  nlv_cap_fraction: number;
  applied_fraction: number;
  capped_by_12pct_nlv: boolean;
  portfolio_nlv_usd: number;
  recommended_notional_usd: number;
  recommended_contracts: number;
  single_asset_exposure_pct: number;
  intraday_drawdown_bps: number;
}

export interface CrossVenueFeeBreakdown {
  asset_pair: string;
  kalshi_ticker: string;
  yes_bid_dollars: number;
  yes_ask_dollars: number;
  yes_bid_size_fp: string;
  yes_ask_size_fp: string;
  orderbook_imbalance_ratio: number;
  gross_prob_delta_bps: number;
  kalshi_taker_fee_dollars: number;
  kalshi_maker_fee_dollars: number;
  polymarket_fee_bps: number;
  coinbase_fee_bps: number;
  net_taker_edge_bps: number;
  net_maker_edge_bps: number;
  ws_seq: number;
  ws_clock_drift_ms: number;
  telemetry_latency_ms: number;
}

export interface OrchestratorCycleTelemetry {
  sessionHydratedAtMs: number;
  sessionHydrationAgeMs: number;
  isHydrationFreshUnder1500ms: boolean;
  turnToolBudgetMax: number;
  turnToolCallsUsed: number;
  parallelPhase1And2Batched: boolean;
  circuitBreakerState: {
    status: 'NOMINAL' | 'RETRY_SUCCEEDED' | 'HALTED_DLQ';
    retriesAttempted: number;
    maxRetriesAllowed: number;
    lastDlqEventId: string | null;
    lastFaultReason: string | null;
  };
  halfKellySizing: HalfKellySizingBreakdown;
  crossVenueTelemetry: CrossVenueFeeBreakdown;
  postgresTables: {
    dialect: 'PostgreSQL 16';
    portfolio_positions: PostgresPortfolioPositionRow[];
    market_signals: PostgresMarketSignalRow[];
    lastSqlQuery: string;
    lastSqlLatencyMs: number;
  };
  latestOutputContract: OrchestratorOutputContract;
  cycleHistory: OrchestratorOutputContract[];
}

export interface ZeroHoldLatencyScalpConfig {
  maxEntryLatencyMs: number;
  minHoldSeconds: number;
  maxHoldSeconds: number;
  makerTakeProfitTicksCents: number;
  iocFlattenOnLatencyDecay: boolean;
  profitVaultSweepPct: number;
  reinvestableFloatPct: number;
  parallelFiveSeriesEnabled: boolean;
  autoSweepDustToFloatEnabled: boolean;
}

export interface SeriesBanditArmTelemetry {
  seriesTicker: string;
  underlyingSpotSymbol: string;
  pulls: number;
  wins: number;
  winRatePct: number;
  avgEntryPrice: number;
  avgExitPrice: number;
  avgRealizedEdgeCents: number;
  brierScore: number;
  brierSkillScore: number;
  atrBaselineMultiplier: number;
  volatilityRegimeBand: 'OPTIMAL_1.0X_1.5X_GOLDILOCKS' | 'LOW_COMPRESSION_SUB_1.0X' | 'HIGH_NOISE_ABOVE_1.5X_THROTTLED';
  volatilityRegimeWeight: number;
  rawUcbScore: number;
  ucbScore: number;
  recommendedSweetSpotBand: [number, number];
  recommendedTakeProfitCents: number;
  allocatedCapitalUsd: number;
  allocationSharePct: number;
  status: 'PROMOTED_LIVE' | 'ACTIVE_ROTATION' | 'EXPLORATION_CAP';
  rationale: string;
}

export interface ParallelSeriesLeadLagRow {
  seriesTicker: 'KXBTC15M' | 'KXETH15M' | 'KXSOL15M' | 'KXXRP15M' | 'KXDOGE15M';
  spotPair: 'BTC-USD' | 'ETH-USD' | 'SOL-USD' | 'XRP-USD' | 'DOGE-USD';
  spotPrice: number;
  strikePrice: number;
  spotImpulseBps: number;
  spotToClobLatencyMs: number;
  latencyGatePassed: boolean;
  atrBaselineMultiplier: number;
  volatilityRegimeBand: 'OPTIMAL_1.0X_1.5X_GOLDILOCKS' | 'LOW_COMPRESSION_SUB_1.0X' | 'HIGH_NOISE_ABOVE_1.5X_THROTTLED';
  volatilityRegimeWeight: number;
  ucbScore: number;
  allocatedCapitalUsd: number;
  allocationSharePct: number;
  yesBidDollars: number;
  yesAskDollars: number;
  yesBidSizeFp: string;
  yesAskSizeFp: string;
  orderbookImbalanceRatio: number;
  grossProbDeltaBps: number;
  netMakerEdgeBps: number;
  netTakerEdgeBps: number;
  recommendedContracts: number;
  halfKellyFractionPct: number;
  status: 'READY_SUB_250MS_SCALP' | 'LATENCY_EXPIRED_HOLD' | 'HIGH_NOISE_ATR_THROTTLED' | 'EDGE_BELOW_THRESHOLD';
  exitPlan: string;
}

export interface ZeroHoldScalpExecutionRecord {
  scalpId: string;
  timestamp: string;
  seriesTicker: string;
  spotPair: string;
  entryLatencyMs: number;
  holdDurationSeconds: number;
  maxHoldCeilingSeconds: number;
  contracts: number;
  entryPriceDollars: number;
  exitPriceDollars: number;
  exitRoutingMode: 'POST_ONLY_MAKER_TP' | 'IOC_LATENCY_DECAY_FLATTEN';
  makerFeeDollars: number;
  takerFeeDollars: number;
  netRealizedProfitUsd: number;
  netRealizedEdgeBps: number;
  vaulted75PctUsd: number;
  reinvested25PctFloatUsd: number;
  heldInventoryAfterExit: 0;
  rationale: string;
}

export interface WhipsawRegimeTelemetry {
  seriesTicker: 'KXBTC15M' | 'KXETH15M' | 'KXSOL15M' | 'KXXRP15M' | 'KXDOGE15M';
  spotSymbol: 'BTC-USD' | 'ETH-USD' | 'SOL-USD' | 'XRP-USD' | 'DOGE-USD';
  currentSpotPrice: number;
  activeStrikePrice: number;
  spotToStrikeDistanceBps: number;
  strikeCrossCount15m: number;
  minRequiredStrikeCrosses: number;
  choppinessIndex14: number;
  minRequiredChoppinessIndex: number;
  atrBaselineMultiplier: number;
  minutesRemainingInWindow: number;
  preExpiryFlattenTriggered: boolean;
  whipsawGatePassed: boolean;
  whipsawPosture:
    | 'WHIPSAW_SCALP_ELIGIBLE'
    | 'STANDBY_ONE_WAY_TREND'
    | 'STANDBY_FAR_FROM_STRIKE'
    | 'PRE_EXPIRY_HARD_FLATTEN_T4M';
  gateStatusReason: string;
}

export interface NonExpirySpotMeanReversionSignal {
  symbol: string;
  name: string;
  venue: 'PUBLIC_SPOT_ETF' | 'COINBASE_SPOT';
  currentPrice: number;
  microVwapPrice: number;
  vwapDeviationBps: number;
  bollingerPercentB: number;
  rsi14: number;
  atrStopLossPrice: number;
  targetSnapbackPrice: number;
  expectedSnapbackBps: number;
  thetaDecayPerHourUsd: 0;
  allocationWeightPct: number;
  allocatedCapitalUsd: number;
  posture: 'ACTIVE_MEAN_REVERSION_BUY' | 'HOLDING_SNAPBACK_TARGET' | 'TAKE_PROFIT_HARVEST_READY';
  rationale: string;
}

export interface KernelPreTradeFirewallTelemetry {
  enabled: true;
  enforcedParityBand: [number, number];
  preExpiryCutoffMinutes: number;
  forcePostOnlyMakerOnEntries: true;
  protectedEquityFloorUsd: number;
  currentKalshiEquityUsd: number;
  houseProfitBufferUsd: number;
  dynamicMaxContracts: number;
  blockedOutsideBandCount: number;
  blockedLateWindowCount: number;
  clampedOversizedOrderCount: number;
  blockedSameWindowReentryCount: number;
  lastBlockedReason: string | null;
}

export interface TickVelocityL2BurstSignal {
  seriesTicker: 'KXBTC15M' | 'KXETH15M' | 'KXSOL15M' | 'KXXRP15M' | 'KXDOGE15M';
  spotSymbol: 'BTC-USD' | 'ETH-USD' | 'SOL-USD' | 'XRP-USD' | 'DOGE-USD';
  tickVelocity5sBps: number;
  minVelocityThresholdBps: number;
  l2DepthSweepRatio: number;
  minSweepRatioThreshold: number;
  clobRepricingLagMs: number;
  executableMakerBidDollars: number;
  targetBurstExitDollars: number;
  expectedBurstDurationSec: number;
  recommendedContracts: number;
  burstTriggered: boolean;
  status: 'BURST_SCALP_TRIGGERED' | 'AWAITING_5S_VELOCITY' | 'AWAITING_L2_SWEEP';
  rationale: string;
}

export interface PublicEtfRotationPlan {
  availableBuyingPowerUsd: number;
  activeEtfDeploymentBudgetUsd: number;
  minAlphaRotationThresholdBps: number;
  laggingPositionsToRotate: Array<{
    symbol: string;
    currentValueUsd: number;
    unrealizedPnlPct: number;
    staleLimitOrderPrice: number | null;
    rotationAction: 'LIQUIDATE_AND_ROTATE_TO_ETF' | 'ROTATED_TO_ETF_SNAPBACK';
    targetEtfSymbol: string;
    targetEtfExpectedAlphaBps: number;
    rationale: string;
  }>;
  etfMeanReversionAllocations: Array<{
    symbol: 'IBIT' | 'ETHA' | 'SPY' | 'QQQ';
    name: string;
    currentPrice: number;
    microVwapPrice: number;
    bollingerPercentB: number;
    rsi14: number;
    expectedSnapbackBps: number;
    trancheDeploymentUsd: number;
    status: 'ACTIVE_MEAN_REVERSION_TRANCHE' | 'READY_FOR_ROTATION_FILL';
    rationale: string;
  }>;
}

export interface CapitalRecoveryGuardrailState {
  recoveryModeActive: boolean;
  primaryEngineMode: 'NON_EXPIRY_SPOT_ETF_MEAN_REVERSION_PLUS_WHIPSAW_GATED_KALSHI';
  startingKalshiCashBaselineUsd: number;
  currentKalshiCashUsd: number;
  bankedRecoveryProfitUsd: number;
  targetRecoveryProfitToUnlockUsd: number;
  recoveryProgressPct: number;
  maxKalshiCycleRiskUsd: number;
  maxContractsPerWhipsawOrder: number;
  preExpiryHardFlattenMinutes: number;
  enforceReduceOnlyExits: boolean;
  zeroExpirySettlementLossesSaved: number;
  tMinus4mFlattensExecuted: number;
  adverseSelectionPaperParityActive: boolean;
  adverseSelectionToxicFillPenaltyPct: number;
  queuePriorityRequireThroughCents: number;
  whipsawSeriesTelemetry: WhipsawRegimeTelemetry[];
  spotMeanReversionSignals: NonExpirySpotMeanReversionSignal[];
  kernelFirewall?: KernelPreTradeFirewallTelemetry;
  tickVelocityBursts?: TickVelocityL2BurstSignal[];
  publicEtfRotation?: PublicEtfRotationPlan;
  lastEvaluatedAt: string;
}

export interface ZeroHoldLeadLagSystemState {
  config: ZeroHoldLatencyScalpConfig;
  currentHeldInventoryContracts: 0;
  totalZeroHoldScalpsCompleted: number;
  makerTpExitRatePct: number;
  iocTimeStopFlattenRatePct: number;
  meanEntryLatencyMs: number;
  meanHoldDurationSeconds: number;
  cumulativeScalpNetProfitUsd: number;
  lockedProfitVaultUsd: number;
  reinvestableScalpFloatUsd: number;
  sweptDustToFloatUsd: number;
  parallelSeriesMatrix: ParallelSeriesLeadLagRow[];
  banditArms?: SeriesBanditArmTelemetry[];
  capitalRecoveryGuardrails?: CapitalRecoveryGuardrailState;
  recentScalpExecutions: ZeroHoldScalpExecutionRecord[];
}

export interface AgentFleetAutoRebalanceTransfer {
  transferId: string;
  timestamp: string;
  fromAgentId: string;
  fromAgentName: string;
  fromSymbol: string;
  donorUcbScore: number;
  donorSharpeRatio: number;
  toAgentId: string;
  toAgentName: string;
  toSymbol: string;
  recipientUcbScore: number;
  recipientSharpeRatio: number;
  amountShiftedUsd: number;
  rationale: string;
}

export interface AgentFleetAutoRebalanceState {
  enabled: boolean;
  intervalSeconds: number;
  totalCyclesExecuted: number;
  lastRebalancedAt: string | null;
  totalCapitalShiftedUsd: number;
  explorationFloorUsd: number;
  singleAssetNlvCapPct: number;
  top2RecipientAgents: Array<{
    agentId: string;
    name: string;
    targetSymbol: string;
    sharpeRatio: number;
    ucbScore: number;
    previousCapitalUsd: number;
    newCapitalUsd: number;
    capitalAddedUsd: number;
    allocationSharePct: number;
  }>;
  underperformingDonorAgents: Array<{
    agentId: string;
    name: string;
    targetSymbol: string;
    sharpeRatio: number;
    ucbScore: number;
    previousCapitalUsd: number;
    newCapitalUsd: number;
    capitalShiftedOutUsd: number;
  }>;
  recentTransfers: AgentFleetAutoRebalanceTransfer[];
  rationale: string;
}
