import rawStrategyParams from '../../strategy_params.json';

export interface BtcLeadLagSniperParams {
  id: 'BTC_LEAD_LAG_SNIPER';
  askGateMin: number;
  askGateMax: number;
  minNetEdgeDollars: number;
  timeWindowMinutes: [number, number];
  volCushionNearExpiryThresholdMins: number;
  volCushionNearExpiryMult: number;
  volCushionStandardMult: number;
  nd2Weight: number;
  mlWeight: number;
  maxContracts: number;
  maxRiskUsd: number;
  feePerContract: number;
  stopAtr: number;
  tpAtr: number;
}

export const STRATEGY_PARAMS: { btcLeadLagSniper: BtcLeadLagSniperParams } = {
  btcLeadLagSniper: {
    ...rawStrategyParams.btcLeadLagSniper,
    id: 'BTC_LEAD_LAG_SNIPER',
    timeWindowMinutes: [
      rawStrategyParams.btcLeadLagSniper.timeWindowMinutes[0],
      rawStrategyParams.btcLeadLagSniper.timeWindowMinutes[1],
    ],
  },
};

export const LEAD_LAG_PARAMS: BtcLeadLagSniperParams = STRATEGY_PARAMS.btcLeadLagSniper;

export const LEAD_LAG_ASK_BAND_TEXT = `[$${LEAD_LAG_PARAMS.askGateMin.toFixed(2)}, $${LEAD_LAG_PARAMS.askGateMax.toFixed(2)}]`;
export const LEAD_LAG_ASK_RANGE_TEXT = `$${LEAD_LAG_PARAMS.askGateMin.toFixed(2)}–$${LEAD_LAG_PARAMS.askGateMax.toFixed(2)}`;
export const LEAD_LAG_MIN_EDGE_TEXT = `+$${LEAD_LAG_PARAMS.minNetEdgeDollars.toFixed(3)}`;
export const LEAD_LAG_WINDOW_TEXT = `[${LEAD_LAG_PARAMS.timeWindowMinutes[0].toFixed(1)}m, ${LEAD_LAG_PARAMS.timeWindowMinutes[1].toFixed(1)}m]`;
export const LEAD_LAG_BLEND_PCT_TEXT = `${Math.round(LEAD_LAG_PARAMS.nd2Weight * 100)}/${Math.round(LEAD_LAG_PARAMS.mlWeight * 100)}`;

export const LEAD_LAG_CATALOG_LABEL = `Coinbase-to-Kalshi 15m Lead-Lag Sniper (${LEAD_LAG_ASK_RANGE_TEXT} Gate + ${LEAD_LAG_BLEND_PCT_TEXT} N(d2)/ML)`;
export const LEAD_LAG_CATALOG_FORMULA = `Ask in ${LEAD_LAG_ASK_BAND_TEXT} + Net Edge >= ${LEAD_LAG_MIN_EDGE_TEXT} + T in ${LEAD_LAG_WINDOW_TEXT} + ${Math.round(LEAD_LAG_PARAMS.nd2Weight * 100)}% Jump-N(d2)/${Math.round(LEAD_LAG_PARAMS.mlWeight * 100)}% ML + Max ${LEAD_LAG_PARAMS.maxContracts} Contracts ($${LEAD_LAG_PARAMS.maxRiskUsd.toFixed(0)} Cap)`;
