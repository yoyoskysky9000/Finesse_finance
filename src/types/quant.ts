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
export type AgentStatus = 'ACTIVE' | 'PAUSED' | 'HALTED_BY_KILL_SWITCH';
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

export interface LeadLagSignalEvaluation {
  ts: string;
  coinbaseSpot: number;
  strike: number;
  minutesLeft: number;
  yesAsk: number;
  noAsk: number;
  annualVol: number;
  feePerContract: number;
  d2: number;
  fairYesProb: number;
  fairNoProb: number;
  yesNetEdge: number;
  noNetEdge: number;
  bestSide: 'BUY_YES' | 'BUY_NO';
  bestAsk: number;
  netEdgePerContract: number;
  action: 'BUY_YES' | 'BUY_NO' | 'HOLD';
  contracts: number;
  totalRiskUsd: number;
  feeGatePassed: boolean;
  edgeGatePassed: boolean;
  rationale: string;
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

export interface ExecutedOrder {
  id: string;
  timestamp: string;
  agentId: string;
  agentName: string;
  symbol: string;
  venue: ExecutionVenue;
  side: 'BUY' | 'SELL' | 'BUY_YES' | 'BUY_NO';
  orderType: 'LIMIT_OCO' | 'MARKET_IOC' | 'STOP_LOSS_EXIT';
  quantity: number;
  fillPrice: number;
  stopLossPrice: number;
  takeProfitPrice: number;
  regimeAtEntry: MarketRegime;
  status: 'FILLED' | 'WORKING_OCO' | 'CANCELLED_BY_KILL_SWITCH';
  rationale: string;
}

export interface AutonomousAgent {
  id: string;
  name: string;
  archetype: StrategyArchetype;
  venue: ExecutionVenue;
  targetSymbol: string;
  timeframe: '1m' | '5m' | '15m' | '4H' | '1D' | '1W';
  status: AgentStatus;
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
    | 'RISK_GOVERNANCE';
  inputSchema: Record<string, any>;
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
  transport: 'HTTP_JSON_RPC' | 'SSE_STREAM' | 'STDIO_BRIDGE';
  endpointUrl: string;
  protocolVersion: string;
  status: 'CONNECTED' | 'DEGRADED' | 'DISCONNECTED';
  latencyMs: number;
  authType: string;
  toolsCount: number;
  resourcesCount: number;
  lastPingAt: string;
  capabilities: string[];
}

export interface McpCallLogEntry {
  id: string;
  timestamp: string;
  serverId: string;
  method: string;
  toolOrResourceName: string;
  args: Record<string, any>;
  durationMs: number;
  status: 'SUCCESS' | 'ERROR';
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
  | 'CIRCUIT_BREAKER_RESET';

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



