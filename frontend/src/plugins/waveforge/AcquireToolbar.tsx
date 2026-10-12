import { useState } from "react";
import type { ScopePreset } from "./scopeTypes";

interface Props {
  running: boolean;
  paused: boolean;
  onRun: () => void;
  onStop: () => void;
  onSingle: () => void;
  onAutoSet: () => void;
  onForceTrigger: () => void;
  onClear: () => void;
  rollMode: boolean;
  onToggleRollMode: () => void;
  triggerMode: "auto" | "normal" | "single" | "smart";
  onSetTriggerMode: (mode: "auto" | "normal" | "single" | "smart") => void;
  onSaveRef: () => void;
  onClearRef: () => void;
  hasRef: boolean;
  sampleRateLabel: string;
  sDivLabel: string;
  connected: boolean;
  presets: ScopePreset[];
  selectedPreset: string | null;
  onSelectPreset: (name: string) => void;
  onSavePreset: (name: string) => void;
  onLoadPreset: () => void;
  onDeletePreset: () => void;
  onExportPresets: () => string;
  onImportPresets: (json: string) => void;
  onExportCsv: () => void;
  onExportPng: () => void;
  onExportSr: () => void;
  onOpenSr: (file: File) => void;
  onSetCursorA: () => void;
  onSetCursorB: () => void;
}

export function AcquireToolbar({
  running, paused, onRun, onStop, onSingle, onAutoSet, onForceTrigger, onClear,
  rollMode, onToggleRollMode,
  triggerMode, onSetTriggerMode,
  onSaveRef, onClearRef, hasRef,
  sampleRateLabel, sDivLabel, connected,
  presets, selectedPreset, onSelectPreset, onSavePreset, onLoadPreset, onDeletePreset,
  onExportPresets, onImportPresets, onExportCsv, onExportPng, onExportSr, onOpenSr,
  onSetCursorA, onSetCursorB,
}: Props) {
  const [presetName, setPresetName] = useState('Setup');
  const [presetJson, setPresetJson] = useState<string | null>(null);
  return (
    <div className="flex flex-wrap items-center gap-2 px-3 py-1.5 border-b border-fob-border bg-fob-surface min-h-[44px] shrink-0 select-none">
      {/* Acquire buttons — hardware order */}
      <button
        onClick={onRun}
        disabled={running || !connected}
        className="px-3 py-1 rounded bg-fob-green text-fob-accent-text font-bold text-[11px] hover:bg-fob-green/80 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
      >
        Run
      </button>
      <button
        onClick={onStop}
        disabled={!running}
        className="px-3 py-1 rounded bg-fob-red text-fob-accent-text font-bold text-[11px] hover:bg-fob-red/80 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
      >
        Stop
      </button>
      <button
        onClick={onSingle}
        disabled={!connected}
        className="px-3 py-1 rounded bg-fob-blue text-fob-accent-text font-bold text-[11px] hover:bg-fob-blue/80 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
      >
        Single
      </button>
      <button
        onClick={onToggleRollMode}
        disabled={!connected}
        className={`px-3 py-1 rounded font-bold text-[11px] transition-colors disabled:opacity-40 disabled:cursor-not-allowed ${
          rollMode
            ? "bg-fob-orange text-fob-accent-text"
            : "bg-fob-surface border border-fob-border text-fob-text hover:bg-fob-border"
        }`}
      >
        Roll
      </button>
      <div className="w-px h-5 bg-fob-border mx-1" />
      <button
        onClick={onAutoSet}
        disabled={!connected}
        className="px-3 py-1 rounded bg-fob-orange text-fob-accent-text font-bold text-[11px] hover:bg-fob-orange/80 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
      >
        AutoSet
      </button>
      <button
        onClick={onForceTrigger}
        disabled={!connected || !running}
        className="px-2 py-1 rounded bg-fob-surface border border-fob-border text-fob-text font-bold text-[11px] hover:bg-fob-border disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
      >
        Force Trig
      </button>
      <button
        onClick={onClear}
        className="px-2 py-1 rounded bg-fob-surface border border-fob-border text-fob-text font-bold text-[11px] hover:bg-fob-border transition-colors"
      >
        Clear
      </button>
      <button
        onClick={onSaveRef}
        disabled={!connected}
        className="px-2 py-1 rounded bg-fob-surface border border-fob-border text-fob-text font-bold text-[11px] hover:bg-fob-border disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
      >
        Save Ref
      </button>
      {hasRef && (
        <button
          onClick={onClearRef}
          className="px-2 py-1 rounded bg-fob-surface border border-fob-border text-fob-text font-bold text-[11px] hover:bg-fob-border transition-colors"
        >
          Clear Ref
        </button>
      )}
      <button
        onClick={onExportCsv}
        className="px-2 py-1 rounded bg-fob-surface border border-fob-border text-fob-text font-bold text-[11px] hover:bg-fob-border transition-colors"
      >
        CSV
      </button>
      <button
        onClick={onExportPng}
        className="px-2 py-1 rounded bg-fob-surface border border-fob-border text-fob-text font-bold text-[11px] hover:bg-fob-border transition-colors"
      >
        PNG
      </button>
      <button onClick={onExportSr}
        className="px-2 py-1 rounded bg-fob-surface border border-fob-border text-fob-text font-bold text-[11px] hover:bg-fob-border transition-colors">
        SR
      </button>
      <label className="px-2 py-1 rounded bg-fob-surface border border-fob-border text-fob-text font-bold text-[11px] hover:bg-fob-border transition-colors cursor-pointer">
        Open SR
        <input type="file" accept=".sr" aria-label="Open SR" className="hidden"
          onChange={(e) => { const file = e.target.files?.[0]; if (file) onOpenSr(file); e.target.value = ""; }} />
      </label>
      <div className="w-px h-5 bg-fob-border mx-1" />
      <button
        onClick={onSetCursorA}
        className="px-2 py-1 rounded bg-fob-surface border border-fob-border text-fob-orange font-bold text-[11px] hover:bg-fob-border transition-colors"
      >
        Set A
      </button>
      <button
        onClick={onSetCursorB}
        className="px-2 py-1 rounded bg-fob-surface border border-fob-border text-fob-blue font-bold text-[11px] hover:bg-fob-border transition-colors"
      >
        Set B
      </button>
      <div className="w-px h-5 bg-fob-border mx-1" />
      {/* Trigger mode toggle — auto / normal / single / smart */}
      <div className="flex rounded overflow-hidden border border-fob-border">
        {(["auto", "normal", "single", "smart"] as const).map((m) => (
          <button
            key={m}
            onClick={() => onSetTriggerMode(m)}
            className={`px-2 py-1 text-[11px] font-bold transition-colors ${
              triggerMode === m
                ? "bg-fob-blue text-fob-accent-text"
                : "bg-fob-surface text-fob-text hover:bg-fob-border"
            }`}
          >
            {m === "auto" ? "Auto" : m === "normal" ? "Norm" : m === "single" ? "Single" : "Smart"}
          </button>
        ))}
      </div>

      <div className="w-px h-5 bg-fob-border mx-1" />

      {/* Preset manager */}
      <div className="flex items-center gap-1">
        <input aria-label="Preset name" value={presetName} onChange={e => setPresetName(e.target.value)}
          className="w-24 h-6 px-1 text-[11px] bg-fob-surface border border-fob-border rounded"
        />
        <select
          value={selectedPreset ?? ""}
          onChange={(e) => onSelectPreset(e.target.value)}
          className="h-6 px-1 text-[11px] bg-fob-surface border border-fob-border rounded text-fob-text focus:outline-none focus:border-fob-blue"
        >
          <option value="">Preset…</option>
          {presets.map((p) => (
            <option key={p.name} value={p.name}>{p.name}</option>
          ))}
        </select>
        <button
          onClick={() => onSavePreset(presetName)}
          disabled={!presetName.trim()}
          className="px-2 py-1 rounded bg-fob-surface border border-fob-border text-fob-text font-bold text-[11px] hover:bg-fob-border transition-colors"
        >
          Save
        </button>
        <button
          onClick={onLoadPreset}
          disabled={!selectedPreset}
          className="px-2 py-1 rounded bg-fob-surface border border-fob-border text-fob-text font-bold text-[11px] hover:bg-fob-border disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
        >
          Load
        </button>
        <button
          onClick={onDeletePreset}
          disabled={!selectedPreset}
          className="px-2 py-1 rounded bg-fob-surface border border-fob-border text-fob-red font-bold text-[11px] hover:bg-fob-border disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
        >
          Del
        </button>
        <button
          onClick={() => setPresetJson(onExportPresets())}
          disabled={presets.length === 0}
          className="px-2 py-1 rounded bg-fob-surface border border-fob-border text-fob-text font-bold text-[11px] hover:bg-fob-border disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
        >
          Export
        </button>
        <button onClick={() => setPresetJson('')} className="px-2 py-1 rounded border border-fob-border">Import JSON</button>
        <label className="px-2 py-1 rounded bg-fob-surface border border-fob-border text-fob-text font-bold text-[11px] hover:bg-fob-border transition-colors cursor-pointer">
          Import file
          <input
            type="file"
            accept=".json,application/json"
            className="hidden"
            onChange={async (e) => {
              const file = e.target.files?.[0];
              if (!file) return;
              const text = await file.text();
              onImportPresets(text);
              e.target.value = "";
            }}
          />
        </label>
      </div>

      {presetJson !== null && <div role="dialog" aria-label="Preset transfer" className="fixed inset-0 z-50 flex items-center justify-center bg-black/60">
        <div className="w-[90%] max-w-2xl p-4 rounded border border-fob-border bg-fob-surface">
          <p className="mb-2">Preset JSON — copy to export, or paste and import.</p>
          <textarea aria-label="Preset JSON" value={presetJson} onChange={e=>setPresetJson(e.target.value)}
            className="w-full h-64 p-2 bg-fob-bg border border-fob-border select-text" />
          <div className="flex gap-2 mt-2">
            <button onClick={()=>{onImportPresets(presetJson);setPresetJson(null);}} className="px-3 py-1 rounded border border-fob-border">Import JSON</button>
            <button onClick={()=>{
              const url=URL.createObjectURL(new Blob([presetJson],{type:'application/json'}));
              const link=document.createElement('a');link.href=url;link.download='scope-presets.json';link.click();URL.revokeObjectURL(url);
            }} className="px-3 py-1 rounded border border-fob-border">Download file</button>
            <button onClick={()=>setPresetJson(null)} className="px-3 py-1 rounded border border-fob-border">Close</button>
          </div>
        </div>
      </div>}

      <div className="flex-1" />

      {/* Status readouts */}
      <span className="text-[10px] text-fob-text-dim font-mono">{sampleRateLabel}</span>
      <span className="text-[10px] text-fob-text-dim font-mono">{sDivLabel}</span>
      <span className={`w-2 h-2 rounded-full ${connected ? "bg-fob-green" : "bg-fob-border"}`} />
      <span className="text-[10px] text-fob-text-dim font-mono">{connected ? "USB" : "OFF"}</span>
      {running && !paused && (
        <span className="text-[10px] text-fob-green font-mono animate-pulse">ACQ</span>
      )}
      {paused && (
        <span className="text-[10px] text-fob-orange font-mono">HOLD</span>
      )}
    </div>
  );
}
