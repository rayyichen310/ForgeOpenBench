interface Cursor {
  sample: number;
  dragging: boolean;
}

interface Props {
  enabled: boolean;
  onToggle: (enabled: boolean) => void;
  cursorA: Cursor;
  cursorB: Cursor;
  onCursorAChange: (cursor: Cursor) => void;
  onCursorBChange: (cursor: Cursor) => void;
  totalSamples: number;
}

export function LaCursorsPanel({ enabled, onToggle, cursorA, cursorB, onCursorAChange, onCursorBChange, totalSamples }: Props) {
  return (
    <div className="flex flex-col gap-2">
      <label className="flex items-center gap-2 text-fob-text-dim cursor-pointer">
        <input
          type="checkbox"
          checked={enabled}
          onChange={e => onToggle(e.target.checked)}
          className="accent-fob-orange"
        />
        Show cursors
      </label>

      {enabled && (
        <div className="flex flex-col gap-1.5">
          <label className="flex flex-col gap-1 text-fob-text-dim">
            Cursor A
            <input
              type="range"
              min={0}
              max={Math.max(0, totalSamples - 1)}
              value={Math.min(cursorA.sample, totalSamples - 1)}
              onChange={e => onCursorAChange({ ...cursorA, sample: Number(e.target.value) })}
              className="accent-fob-red"
            />
          </label>
          <label className="flex flex-col gap-1 text-fob-text-dim">
            Cursor B
            <input
              type="range"
              min={0}
              max={Math.max(0, totalSamples - 1)}
              value={Math.min(cursorB.sample, totalSamples - 1)}
              onChange={e => onCursorBChange({ ...cursorB, sample: Number(e.target.value) })}
              className="accent-fob-blue"
            />
          </label>
        </div>
      )}
    </div>
  );
}
