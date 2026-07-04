import type { LaChannel } from "./laChannelConfig";
import { CHANNEL_COLORS } from "./laChannelConfig";

interface Props {
  channels: LaChannel[];
  onChange: (channels: LaChannel[]) => void;
}

export function ChannelsPanel({ channels, onChange }: Props) {
  const updateChannel = (id: number, patch: Partial<LaChannel>) => {
    onChange(channels.map(c => (c.id === id ? { ...c, ...patch } : c)));
  };

  const moveChannel = (fromIndex: number, toIndex: number) => {
    const next = [...channels];
    const [moved] = next.splice(fromIndex, 1);
    next.splice(toIndex, 0, moved);
    onChange(next);
  };

  const resetChannels = () => {
    onChange(
      Array.from({ length: 16 }, (_, i) => ({
        id: i,
        label: `D${i}`,
        color: CHANNEL_COLORS[i],
        enabled: true,
        visible: true,
        decoder: null,
      }))
    );
  };

  return (
    <div className="flex flex-col gap-1">
      {channels.map((ch, i) => (
        <div
          key={ch.id}
          draggable
          onDragStart={e => {
            e.dataTransfer.setData("text/plain", String(i));
            e.dataTransfer.effectAllowed = "move";
          }}
          onDragOver={e => {
            e.preventDefault();
            e.dataTransfer.dropEffect = "move";
          }}
          onDrop={e => {
            e.preventDefault();
            const from = Number(e.dataTransfer.getData("text/plain"));
            if (!isNaN(from) && from !== i) moveChannel(from, i);
          }}
          className="flex items-center gap-1 px-2 py-1 rounded text-xs font-mono border select-none"
          style={{
            borderColor: ch.color,
            color: ch.enabled ? ch.color : getComputedStyle(document.documentElement).getPropertyValue("--fob-border").trim(),
            background: ch.enabled ? `${ch.color}18` : "transparent",
            opacity: ch.visible ? 1 : 0.5,
          }}
        >
          <span className="cursor-grab active:cursor-grabbing leading-none px-1" title="Drag to reorder">≡</span>
          <span className="w-6 text-center text-fob-text-dim">D{ch.id}</span>
          <input
            type="text"
            value={ch.label}
            onChange={e => updateChannel(ch.id, { label: e.target.value.slice(0, 12) })}
            className="flex-1 min-w-0 bg-transparent px-1 text-xs focus:outline-none focus:ring-1 focus:ring-fob-border rounded"
            title="Click to rename"
          />
          <button
            onClick={() => updateChannel(ch.id, { visible: !ch.visible })}
            title={ch.visible ? "Hide trace" : "Show trace"}
            className="leading-none px-1 py-1 hover:bg-fob-border/50 rounded"
          >
            {ch.visible ? (
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
                <circle cx="12" cy="12" r="3" />
              </svg>
            ) : (
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24" />
                <line x1="1" y1="1" x2="23" y2="23" />
              </svg>
            )}
          </button>
          <button
            onClick={() => updateChannel(ch.id, { enabled: !ch.enabled })}
            title={ch.enabled ? "Disable capture" : "Enable capture"}
            className="leading-none px-1 py-1 hover:bg-fob-border/50 rounded"
          >
            {ch.enabled ? "✅" : "⬜"}
          </button>
          {ch.decoder && <span className="text-xs leading-none px-1" title={`Decoder: ${ch.decoder}`}>🔍</span>}
          <button
            onClick={() => moveChannel(i, Math.max(0, i - 1))}
            disabled={i === 0}
            className="leading-none px-1 py-1 hover:bg-fob-border/50 disabled:opacity-30 rounded"
            title="Move up"
          >▲</button>
          <button
            onClick={() => moveChannel(i, Math.min(channels.length - 1, i + 1))}
            disabled={i === channels.length - 1}
            className="leading-none px-1 py-1 hover:bg-fob-border/50 disabled:opacity-30 rounded"
            title="Move down"
          >▼</button>
        </div>
      ))}
      <button
        onClick={resetChannels}
        className="px-2 py-1 rounded text-xs bg-fob-surface border border-fob-border hover:bg-fob-border self-start mt-1"
        title="Reset channel order and labels"
      >
        Reset
      </button>
    </div>
  );
}
