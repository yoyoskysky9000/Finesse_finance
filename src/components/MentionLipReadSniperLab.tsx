import React, { useEffect, useState, useCallback } from 'react';
import {
  Activity,
  AlertTriangle,
  ArrowUpRight,
  CheckCircle2,
  Cpu,
  Eye,
  Layers,
  Mic,
  Play,
  RefreshCw,
  ShieldAlert,
  Sparkles,
  Zap,
} from 'lucide-react';
import type {
  AutonomousAgent,
  ExecutedOrder,
  MentionSniperState,
  PortfolioSummary,
} from '../types/quant.ts';

interface MentionLipReadSniperLabProps {
  portfolio: PortfolioSummary | null;
  onStateUpdated: (payload: {
    portfolio?: PortfolioSummary;
    orders?: ExecutedOrder[];
    agents?: AutonomousAgent[];
    bannerMessage?: string;
  }) => void;
}

export const MentionLipReadSniperLab: React.FC<MentionLipReadSniperLabProps> = ({
  portfolio,
  onStateUpdated,
}) => {
  const [mentionState, setMentionState] = useState<MentionSniperState | null>(null);
  const [selectedSpeakerId, setSelectedSpeakerId] = useState<string>('speaker-powell-fomc');
  const [profitDeltaCents, setProfitDeltaCents] = useState<number>(10);
  const [liveStreamInput, setLiveStreamInput] = useState<string>(
    'make our decisions meeting by meeting and remain [V_ALVEOLAR_D_T -> V_BILABIAL_P_B_M]'
  );
  const [contractsQty, setContractsQty] = useState<number>(10);

  // Custom Speaker Deep-Dive Form
  const [customSpeakerName, setCustomSpeakerName] = useState<string>('');
  const [customEventTitle, setCustomEventTitle] = useState<string>('');
  const [customCandidateWords, setCustomCandidateWords] = useState<string>(
    'Tariffs, Soft Landing, Sovereign AI, Rate Cut'
  );

  const [isPlacingSells, setIsPlacingSells] = useState<boolean>(false);
  const [isAnalyzingSpeaker, setIsAnalyzingSpeaker] = useState<boolean>(false);
  const [isSniping, setIsSniping] = useState<boolean>(false);

  const fetchMentionState = useCallback(async () => {
    try {
      const res = await fetch('/api/mentions/state');
      if (res.ok) {
        const data = (await res.json()) as MentionSniperState;
        setMentionState(data);
        if (data.selectedSpeakerId) {
          setSelectedSpeakerId(data.selectedSpeakerId);
        }
      }
    } catch {
      // Keep local state if transient error
    }
  }, []);

  useEffect(() => {
    fetchMentionState();
  }, [fetchMentionState]);

  const activeSpeaker =
    mentionState?.speakers.find((s) => s.speakerId === selectedSpeakerId) ||
    mentionState?.speakers[0] ||
    null;

  const handlePlaceAllKalshiSellOrders = async () => {
    setIsPlacingSells(true);
    try {
      const res = await fetch('/api/kalshi/place-sell-orders', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          profitDeltaCents,
          force: true,
        }),
      });
      if (res.ok) {
        const data = await res.json();
        await fetchMentionState();
        onStateUpdated({
          portfolio: data.portfolio,
          orders: data.orders,
          agents: data.agents,
          bannerMessage: `Placed ${data.sellOrders?.length || data.placedCount || 1} Resting Kalshi Take-Profit SELL Limit Orders (+${profitDeltaCents}¢ target · reduce_only=true on /trade-api/v2/portfolio/events/orders).`,
        });
      }
    } finally {
      setIsPlacingSells(false);
    }
  };

  const handleSelectSpeaker = async (speakerId: string) => {
    setSelectedSpeakerId(speakerId);
    const sp = mentionState?.speakers.find((s) => s.speakerId === speakerId);
    const firstPrecursor = sp?.contracts[0]?.precursorPhrases[0]?.phrase;
    const firstViseme = sp?.contracts[0]?.lipReadSignature.visemeSequence[0];
    if (firstPrecursor) {
      setLiveStreamInput(`...${firstPrecursor} [${firstViseme || 'V_BILABIAL_P_B_M'}]...`);
    }
    try {
      const res = await fetch('/api/mentions/analyze-speaker', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ speakerId }),
      });
      if (res.ok) {
        const data = (await res.json()) as MentionSniperState;
        setMentionState(data);
      }
    } catch {
      // Ignore
    }
  };

  const handleAnalyzeCustomSpeaker = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!customSpeakerName.trim()) return;
    setIsAnalyzingSpeaker(true);
    try {
      const res = await fetch('/api/mentions/analyze-speaker', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          customSpeakerName,
          customEventTitle,
          customCandidateWords,
        }),
      });
      if (res.ok) {
        const data = (await res.json()) as MentionSniperState;
        setMentionState(data);
        setSelectedSpeakerId(data.selectedSpeakerId);
        setCustomSpeakerName('');
        setCustomEventTitle('');
        onStateUpdated({
          bannerMessage: `Gemini 3.8 Flash Speaker Corpus & Optical Viseme Profile synthesized for ${
            data.speakers[0]?.speakerName || 'Speaker'
          }.`,
        });
      }
    } finally {
      setIsAnalyzingSpeaker(false);
    }
  };

  const handleSnipeMentionContract = async (params: {
    contractId?: string;
    bundleId?: string;
    streamOverride?: string;
  }) => {
    setIsSniping(true);
    try {
      const res = await fetch('/api/mentions/trigger-sniper', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          speakerId: selectedSpeakerId,
          contractId: params.contractId,
          bundleId: params.bundleId,
          liveStreamText: params.streamOverride ?? liveStreamInput,
          contractsCount: contractsQty,
        }),
      });
      if (res.ok) {
        const data = await res.json();
        if (data.mentionState) {
          setMentionState(data.mentionState);
        } else {
          await fetchMentionState();
        }
        onStateUpdated({
          portfolio: data.portfolio,
          orders: data.orders,
          agents: data.agents,
          bannerMessage: params.bundleId
            ? `Executed Combinatorial Arbitrage Bundle (${data.bundle?.title}) + Staged Resting Kalshi Take-Profit SELL Orders.`
            : `Lip-Read & Precursor Sniper Fired on "${data.trigger?.targetWord}" (${data.trigger?.leadTimeAdvantageMs}ms pre-audio head start): Routed Kalshi BUY @ $${data.trigger?.buyPrice} + Resting Take-Profit SELL @ $${data.trigger?.targetSellPrice}.`,
        });
      } else {
        const err = await res.json();
        onStateUpdated({
          bannerMessage: err.error || 'Longshot bias filter blocked execution.',
        });
      }
    } finally {
      setIsSniping(false);
    }
  };

  const openPositionsCount = portfolio?.kalshiPositions?.length ?? 0;
  const restingSells = mentionState?.activeRestingSellOrders || [];

  return (
    <div className="border border-cyan-500/40 bg-[#0D1422] p-5 space-y-6">
      {/* Top Header & Instant Kalshi Sell-Order Harvester Bar */}
      <div className="flex flex-wrap items-center justify-between gap-4 border-b border-slate-800 pb-4">
        <div className="space-y-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="px-2 py-0.5 bg-emerald-500/20 border border-emerald-400/50 text-emerald-300 font-mono text-[10px] font-bold">
              AUTO-SELL HARVESTER + LIVE SPEECH MENTION &amp; VISEME LIP-READ SNIPER
            </span>
            <span className="px-2 py-0.5 bg-cyan-500/20 border border-cyan-400/40 text-cyan-300 font-mono text-[10px]">
              OCTOBER 2026 6-STRATEGY SUITE · COMBINATORIAL ARB + &lt;10¢ LONGSHOT FILTER
            </span>
          </div>
          <h2 className="text-base font-bold text-slate-100">
            Kalshi Auto-Take-Profit Sell Engine, Speaker Precursor N-Grams &amp; Live Optical Lip-Reading Lab
          </h2>
          <p className="text-xs text-slate-400">
            Automatically attaches resting <span className="font-mono text-emerald-300">reduce_only=true</span> Take-Profit SELL limit orders to every open Kalshi position &amp; snipes live speech mentions 1.9–2.8s ahead of the crowd using syntactic precursor bridges + 60fps viseme mouth-shape sequences.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2.5">
          <div className="flex items-center gap-1.5 bg-[#090E17] border border-slate-700 px-2.5 py-1.5 rounded text-xs">
            <span className="text-slate-400 font-mono">TP Target:</span>
            <select
              value={profitDeltaCents}
              onChange={(e) => setProfitDeltaCents(Number(e.target.value))}
              className="bg-transparent text-emerald-300 font-mono font-bold focus:outline-none"
            >
              <option value={8} className="bg-slate-900">+8¢ Above Entry</option>
              <option value={10} className="bg-slate-900">+10¢ Above Entry (Recommended)</option>
              <option value={14} className="bg-slate-900">+14¢ Above Entry</option>
              <option value={20} className="bg-slate-900">+20¢ Mention Spike</option>
            </select>
          </div>

          <button
            type="button"
            onClick={handlePlaceAllKalshiSellOrders}
            disabled={isPlacingSells}
            className="px-4 py-2 bg-emerald-500 hover:bg-emerald-400 disabled:opacity-50 text-slate-950 font-bold text-xs rounded transition-colors flex items-center gap-1.5 whitespace-nowrap"
          >
            <ArrowUpRight className="w-4 h-4" />
            <span>
              {isPlacingSells
                ? 'Placing Kalshi Sell Orders...'
                : `Place Take-Profit SELL Orders on Open Kalshi Positions (${openPositionsCount} Active)`}
            </span>
          </button>
        </div>
      </div>

      {/* SECTION 1: Active Resting Kalshi Take-Profit SELL Limit Orders */}
      <div className="p-4 border border-emerald-500/30 bg-[#09111B] space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <CheckCircle2 className="w-4 h-4 text-emerald-400" />
            <h3 className="text-xs font-bold uppercase tracking-wider text-emerald-300 font-mono">
              Active Resting Kalshi Take-Profit SELL Limit Orders ({restingSells.length} Staged · Auto-Sell Paired on Every HFT Buy)
            </h3>
          </div>
          <span className="text-[11px] font-mono text-slate-400">
            Endpoint: <span className="text-cyan-300">POST /trade-api/v2/portfolio/events/orders (side=ask/bid, reduce_only=true)</span>
          </span>
        </div>

        {restingSells.length === 0 ? (
          <div className="flex items-center justify-between p-3 border border-slate-800 bg-[#0B0F17] text-xs text-slate-300">
            <span>
              Ready to stage resting Take-Profit SELL limit orders across your {openPositionsCount} open Kalshi contract positions.
            </span>
            <button
              type="button"
              onClick={handlePlaceAllKalshiSellOrders}
              className="px-3 py-1 bg-emerald-600 hover:bg-emerald-500 text-white font-mono text-[11px] rounded"
            >
              Stage All Sell Orders Now
            </button>
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-2.5">
            {restingSells.slice(0, 6).map((sell) => (
              <div
                key={sell.orderId}
                className="p-3 border border-emerald-500/30 bg-[#0D1624] flex flex-col justify-between gap-2 text-xs"
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="font-mono font-bold text-slate-100 truncate">{sell.ticker}</span>
                  <span className="px-1.5 py-0.5 bg-emerald-500/20 border border-emerald-400/40 text-emerald-300 font-mono text-[10px] font-semibold">
                    {sell.side} × {sell.contracts}
                  </span>
                </div>
                <div className="flex items-center justify-between font-mono text-[11px] text-slate-300">
                  <span>Entry: ${sell.entryPrice.toFixed(2)}</span>
                  <span className="text-emerald-400 font-bold">
                    Target Sell: ${sell.targetSellPrice.toFixed(2)} (+${sell.expectedProfitUsd.toFixed(2)})
                  </span>
                </div>
                <div className="flex items-center justify-between text-[10px] font-mono text-slate-400 pt-1 border-t border-slate-800/80">
                  <span className="truncate text-cyan-300">{sell.exchangeStatus}</span>
                  <span>{new Date(sell.placedAt).toLocaleTimeString()}</span>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* SECTION 2: Speaker Deep-Dive, Precursor Phrases & Live Optical Viseme Lip-Reader */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-5">
        {/* Left 5 Columns: Speaker Selector, Custom Gemini Deep-Dive & Live Stream Lip-Read Trigger */}
        <div className="lg:col-span-5 space-y-4">
          <div className="p-4 border border-slate-800 bg-[#111827] space-y-3">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <Mic className="w-4 h-4 text-cyan-400" />
                <h3 className="text-xs font-bold uppercase tracking-wider text-slate-200 font-mono">
                  1. Select Speaker Corpus Profile
                </h3>
              </div>
              <span className="text-[11px] font-mono text-cyan-400">
                {activeSpeaker?.corpusSpeechesAnalyzed || 64} Speeches Indexed
              </span>
            </div>

            <div className="flex flex-wrap gap-1.5">
              {(mentionState?.speakers || []).map((sp) => (
                <button
                  key={sp.speakerId}
                  type="button"
                  onClick={() => handleSelectSpeaker(sp.speakerId)}
                  className={`px-2.5 py-1.5 text-xs font-medium rounded border transition-colors text-left ${
                    sp.speakerId === activeSpeaker?.speakerId
                      ? 'bg-cyan-500/20 border-cyan-400 text-slate-100'
                      : 'bg-[#0B0F17] border-slate-800 text-slate-400 hover:text-slate-200'
                  }`}
                >
                  <div className="font-semibold text-[11px]">{sp.speakerName.split('·')[0].trim()}</div>
                  <div className="font-mono text-[10px] text-cyan-300">{sp.eventSeriesTicker}</div>
                </button>
              ))}
            </div>

            {activeSpeaker && (
              <div className="p-3 bg-[#090E17] border border-slate-800 space-y-2 text-xs">
                <div className="flex items-center justify-between">
                  <span className="font-semibold text-slate-100">{activeSpeaker.speakerName}</span>
                  <span className="font-mono text-[11px] text-emerald-400">
                    +{activeSpeaker.acousticToVisualLatencyAdvantageMs}ms Viseme Lead
                  </span>
                </div>
                <div className="text-[11px] text-slate-400">{activeSpeaker.eventTitle}</div>
                <p className="text-[11px] text-slate-300 leading-relaxed">
                  {activeSpeaker.rhetoricalCadenceSummary}
                </p>
                <div className="flex items-center justify-between pt-1 border-t border-slate-800/80 font-mono text-[10px] text-cyan-300">
                  <span>Cadence: {activeSpeaker.avgWordsPerMinute} WPM</span>
                  <span>{activeSpeaker.scheduledTimeLabel}</span>
                </div>
              </div>
            )}

            {/* Live Transcript & Optical Viseme Stream Trigger Simulator */}
            <div className="pt-2 border-t border-slate-800 space-y-2.5">
              <div className="flex items-center justify-between text-xs">
                <span className="font-mono font-semibold text-emerald-300 flex items-center gap-1.5">
                  <Eye className="w-3.5 h-3.5" />
                  <span>Live Precursor + Viseme Stream Detector</span>
                </span>
                <span className="font-mono text-[10px] text-slate-400">
                  Order Size: {contractsQty} Contracts
                </span>
              </div>

              <textarea
                rows={2}
                value={liveStreamInput}
                onChange={(e) => setLiveStreamInput(e.target.value)}
                placeholder="Paste live caption stream or precursor phrase..."
                className="w-full p-2.5 bg-[#080C14] border border-slate-700 rounded text-xs font-mono text-slate-100 focus:border-cyan-400 focus:outline-none"
              />

              {/* Quick Precursor Injection Pills */}
              {activeSpeaker && (
                <div className="space-y-1">
                  <div className="text-[10px] text-slate-400 font-mono">
                    Load Live Precursor Bridge + Viseme Frame:
                  </div>
                  <div className="flex flex-wrap gap-1.5">
                    {activeSpeaker.contracts
                      .filter((c) => !c.isLongshotTrapBelow10c)
                      .map((c) => {
                        const p = c.precursorPhrases[0];
                        return (
                          <button
                            key={c.id}
                            type="button"
                            onClick={() =>
                              setLiveStreamInput(
                                `"...${p?.phrase || ''} [${c.lipReadSignature.visemeSequence[0]} → ${
                                  c.lipReadSignature.visemeSequence[1] || ''
                                }]..."`
                              )
                            }
                            className="px-2 py-1 bg-slate-800/90 hover:bg-slate-700 border border-slate-700 text-[10px] font-mono text-cyan-300 rounded truncate max-w-full"
                          >
                            Cue &ldquo;{c.targetWord}&rdquo; ({p?.avgLeadTimeMs || 2100}ms lead)
                          </button>
                        );
                      })}
                  </div>
                </div>
              )}

              <div className="flex items-center gap-2 pt-1">
                <input
                  type="number"
                  min={4}
                  max={25}
                  value={contractsQty}
                  onChange={(e) => setContractsQty(Math.max(4, Math.min(25, Number(e.target.value) || 10)))}
                  className="w-20 px-2.5 py-2 bg-[#080C14] border border-slate-700 rounded text-xs font-mono text-slate-100"
                />
                <button
                  type="button"
                  onClick={() => handleSnipeMentionContract({})}
                  disabled={isSniping}
                  className="flex-1 px-3.5 py-2 bg-cyan-500 hover:bg-cyan-400 disabled:opacity-50 text-slate-950 font-bold text-xs rounded transition-colors flex items-center justify-center gap-1.5"
                >
                  <Zap className="w-3.5 h-3.5" />
                  <span>
                    {isSniping
                      ? 'Sniping Mention + Staging Sell...'
                      : 'Trigger Live Lip-Read Snipe (Buy + Auto-Sell)'}
                  </span>
                </button>
              </div>
            </div>
          </div>

          {/* Custom Gemini 3.8 Flash Speaker Deep-Dive Generator */}
          <form
            onSubmit={handleAnalyzeCustomSpeaker}
            className="p-4 border border-slate-800 bg-[#111827] space-y-2.5 text-xs"
          >
            <div className="flex items-center justify-between">
              <span className="font-mono font-bold text-cyan-300 flex items-center gap-1.5">
                <Sparkles className="w-3.5 h-3.5" />
                <span>Deep-Dive Custom Speaker (Gemini 3.8 Flash)</span>
              </span>
              <span className="text-[10px] font-mono text-slate-400">N-Gram + IPA Visemes</span>
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
              <input
                type="text"
                value={customSpeakerName}
                onChange={(e) => setCustomSpeakerName(e.target.value)}
                placeholder="Speaker (e.g. Elon Musk, Christine Lagarde)"
                className="px-2.5 py-1.5 bg-[#080C14] border border-slate-700 rounded text-xs text-slate-100"
              />
              <input
                type="text"
                value={customEventTitle}
                onChange={(e) => setCustomEventTitle(e.target.value)}
                placeholder="Speech / Earnings Call Title"
                className="px-2.5 py-1.5 bg-[#080C14] border border-slate-700 rounded text-xs text-slate-100"
              />
            </div>
            <input
              type="text"
              value={customCandidateWords}
              onChange={(e) => setCustomCandidateWords(e.target.value)}
              placeholder="Target mention words (comma-separated)"
              className="w-full px-2.5 py-1.5 bg-[#080C14] border border-slate-700 rounded text-xs text-slate-100 font-mono"
            />
            <button
              type="submit"
              disabled={isAnalyzingSpeaker || !customSpeakerName.trim()}
              className="w-full py-1.5 bg-slate-800 hover:bg-slate-700 disabled:opacity-40 border border-cyan-500/40 text-cyan-300 font-semibold rounded transition-colors"
            >
              {isAnalyzingSpeaker
                ? 'Synthesizing Speaker Precursors & Viseme Chains...'
                : 'Generate Speaker Precursor Phrases & Lip-Read Model'}
            </button>
          </form>
        </div>

        {/* Right 7 Columns: Tradable Mention Words, Precursor Lead-Up Phrases & Viseme Lip-Reading Cards */}
        <div className="lg:col-span-7 space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h3 className="text-xs font-bold uppercase tracking-wider text-slate-200 font-mono">
              2. Tradable Mention Contracts, Lead-Up Precursor Bridges &amp; Viseme Mouth-Shapes
            </h3>
            <span className="text-[11px] font-mono text-emerald-400">
              &lt;10¢ Longshot Trap Guardrail Active (-19.3¢/$ Retail Bias Blocked)
            </span>
          </div>

          <div className="space-y-3">
            {(activeSpeaker?.contracts || []).map((contract) => {
              const isBlocked = contract.isLongshotTrapBelow10c;
              return (
                <div
                  key={contract.id}
                  className={`p-4 border space-y-3 ${
                    isBlocked
                      ? 'border-rose-500/40 bg-rose-950/15'
                      : 'border-slate-800 bg-[#111827]'
                  }`}
                >
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <div>
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="text-sm font-bold text-slate-100">
                          &ldquo;{contract.targetWord}&rdquo;
                        </span>
                        <span className="font-mono text-xs text-cyan-400 font-semibold">
                          {contract.kalshiTicker}
                        </span>
                        {isBlocked ? (
                          <span className="px-2 py-0.5 bg-rose-500/20 border border-rose-500/50 text-rose-300 font-mono text-[10px] font-bold">
                            BLOCKED: &lt;10¢ LONGSHOT BIAS TRAP
                          </span>
                        ) : (
                          <span className="px-2 py-0.5 bg-emerald-500/20 border border-emerald-500/40 text-emerald-300 font-mono text-[10px] font-bold">
                            +{contract.netEdgeCents.toFixed(1)}¢ INDEPENDENT FORECAST EDGE
                          </span>
                        )}
                      </div>
                      <div className="mt-1 flex flex-wrap items-center gap-3 text-xs font-mono text-slate-400">
                        <span>
                          Kalshi Ask: <strong className="text-slate-100">${contract.yesAsk.toFixed(2)}</strong>
                        </span>
                        <span>·</span>
                        <span>
                          Independent Forecast:{' '}
                          <strong className="text-emerald-400">
                            {(contract.independentModelProb * 100).toFixed(1)}%
                          </strong>
                        </span>
                        <span>·</span>
                        <span>Base Rate: {contract.historicalMentionBaseRatePct.toFixed(1)}%</span>
                        <span>·</span>
                        <span className="text-amber-300">
                          Auto-Sell TP: ${contract.targetTakeProfitSellPrice.toFixed(2)}
                        </span>
                      </div>
                    </div>

                    {!isBlocked && (
                      <button
                        type="button"
                        onClick={() =>
                          handleSnipeMentionContract({
                            contractId: contract.id,
                            streamOverride: `"...${contract.precursorPhrases[0]?.phrase || ''} [${
                              contract.lipReadSignature.visemeSequence[0]
                            }]..."`,
                          })
                        }
                        disabled={isSniping}
                        className="px-3 py-1.5 bg-emerald-500 hover:bg-emerald-400 text-slate-950 font-bold text-xs rounded transition-colors whitespace-nowrap"
                      >
                        Snipe BUY @ ${contract.yesAsk.toFixed(2)} + Auto-Sell @ $
                        {contract.targetTakeProfitSellPrice.toFixed(2)}
                      </button>
                    )}
                  </div>

                  {/* Precursor Lead-Up Phrases */}
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-2.5 text-xs">
                    <div className="p-2.5 bg-[#090E17] border border-slate-800 space-y-1.5">
                      <div className="font-mono text-[10px] font-bold text-cyan-300 uppercase">
                        Syntactic Lead-Up Precursor Phrases (1.8s–2.9s Early Warning)
                      </div>
                      {contract.precursorPhrases.map((p, idx) => (
                        <div key={`${contract.id}-prec-${idx}`} className="space-y-0.5">
                          <div className="font-mono text-[11px] text-slate-100">
                            &ldquo;...{p.phrase}...&rdquo;
                          </div>
                          <div className="flex items-center justify-between text-[10px] font-mono text-slate-400">
                            <span className="text-emerald-400">
                              P(Mention | Precursor) = {p.transitionProbPct}%
                            </span>
                            <span className="text-amber-300">-{p.avgLeadTimeMs}ms Lead</span>
                          </div>
                        </div>
                      ))}
                    </div>

                    {/* Optical Viseme Lip-Read Signature */}
                    <div className="p-2.5 bg-[#090E17] border border-slate-800 space-y-1.5">
                      <div className="flex items-center justify-between font-mono text-[10px] font-bold text-emerald-300 uppercase">
                        <span>Live Optical Lip-Read Viseme Chain</span>
                        <span>
                          IPA: {contract.lipReadSignature.ipaPhonemes} (-
                          {contract.lipReadSignature.visualLeadAdvantageMs}ms)
                        </span>
                      </div>
                      <div className="flex flex-wrap gap-1">
                        {contract.lipReadSignature.visemeSequence.map((v, vIdx) => (
                          <span
                            key={`${contract.id}-vis-${vIdx}`}
                            className="px-1.5 py-0.5 bg-slate-900 border border-cyan-500/30 font-mono text-[10px] text-cyan-200"
                          >
                            {v}
                          </span>
                        ))}
                      </div>
                      <p className="text-[11px] text-slate-300 leading-snug">
                        {contract.lipReadSignature.mouthArticulationSummary}
                      </p>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      </div>

      {/* SECTION 3: Combinatorial & Semantic Logic Arbitrage Scanner (Oct 2026 Top AI-Bot Candidate) */}
      <div className="space-y-3 pt-2 border-t border-slate-800">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <h3 className="text-xs font-bold uppercase tracking-wider text-cyan-300 font-mono">
              3. Combinatorial &amp; Cross-Platform Arbitrage Scanner (Oct 2026 Preprint · +2.2% Guaranteed Target)
            </h3>
            <p className="text-xs text-slate-400">
              Identifies mutually exclusive contracts summing &gt; 100¢, semantic subset violations, and executable Kalshi vs. Public.com Event Contract spreads net of fees.
            </p>
          </div>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-3 gap-3">
          {(mentionState?.combinatorialArbBundles || []).map((bundle) => (
            <div
              key={bundle.bundleId}
              className="p-3.5 border border-slate-800 bg-[#111827] flex flex-col justify-between space-y-3 text-xs"
            >
              <div className="space-y-2">
                <div className="flex items-center justify-between gap-2">
                  <span className="px-2 py-0.5 bg-emerald-500/20 border border-emerald-500/40 text-emerald-300 font-mono text-[10px] font-bold">
                    +{bundle.lockedArbitrageProfitPct.toFixed(2)}% GUARANTEED NET ARB
                  </span>
                  <span className="font-mono text-[10px] text-slate-400">
                    Window ~{bundle.historicalPersistenceMinutes}m
                  </span>
                </div>
                <div className="font-semibold text-slate-100">{bundle.title}</div>
                <div className="space-y-1 pt-1">
                  {bundle.legs.map((leg, lIdx) => (
                    <div
                      key={`${bundle.bundleId}-leg-${lIdx}`}
                      className="flex items-center justify-between font-mono text-[11px] bg-[#090E17] px-2 py-1 border border-slate-800/80"
                    >
                      <span className="text-cyan-300 truncate">{leg.ticker}</span>
                      <span className="text-slate-300">
                        {leg.action} @ ${leg.executablePrice.toFixed(2)}
                      </span>
                    </div>
                  ))}
                </div>
                <p className="text-[11px] text-slate-300 leading-relaxed">{bundle.rationale}</p>
              </div>

              <div className="pt-2 border-t border-slate-800 flex items-center justify-between">
                <span className="font-mono text-[10px] text-slate-400">
                  Cost {bundle.totalCostAfterFeesCents}¢ → Payout {bundle.guaranteedPayoutCents}¢
                </span>
                <button
                  type="button"
                  onClick={() => handleSnipeMentionContract({ bundleId: bundle.bundleId })}
                  disabled={isSniping}
                  className="px-2.5 py-1 bg-cyan-500 hover:bg-cyan-400 text-slate-950 font-bold text-[11px] rounded transition-colors"
                >
                  Execute Arb + Auto-Sell
                </button>
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* SECTION 4: October 2026 Top 6 Prediction-Market Strategies Reference & Live Status */}
      <div className="space-y-3 pt-2 border-t border-slate-800">
        <div className="flex items-center justify-between">
          <h3 className="text-xs font-bold uppercase tracking-wider text-slate-300 font-mono">
            4. October 26, 2026 Institutional Prediction-Market Strategy Matrix (All 6 Active)
          </h3>
          <span className="text-[11px] font-mono text-emerald-400">
            Pricing &amp; Execution Edge Over Raw Event Guessing
          </span>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
          {(mentionState?.strategies2026 || []).map((strat) => (
            <div
              key={strat.id}
              className="p-3.5 border border-slate-800 bg-[#0B0F17] space-y-2 text-xs"
            >
              <div className="flex items-center justify-between gap-2">
                <span className="font-semibold text-slate-100">{strat.title}</span>
                <span className="px-1.5 py-0.5 bg-cyan-500/15 border border-cyan-500/40 text-cyan-300 font-mono text-[10px] shrink-0">
                  {strat.edgeMetricValue}
                </span>
              </div>
              <div className="text-[11px] font-mono text-emerald-400">{strat.tag}</div>
              <p className="text-[11px] text-slate-300 leading-snug">{strat.coreMechanism}</p>
              <div className="p-2 bg-[#111827] border border-slate-800/80 text-[10px] text-slate-400 leading-snug">
                <strong className="text-slate-200">Oct 2026 Research:</strong>{' '}
                {strat.october2026ResearchFinding}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
};
