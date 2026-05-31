import React from "react";

import type { TranslationKey } from "../i18n";

export type ChartZoomRange = { start: number; end: number };
type ChartRow = Record<string, unknown>;

function clampChartZoomRange(range: ChartZoomRange, length: number) {
  const max = Math.max(length - 1, 0);
  if (max <= 0) return { start: 0, end: 0 };
  const start = Math.max(0, Math.min(range.start, max - 1));
  const end = Math.max(start + 1, Math.min(range.end, max));
  return { start, end };
}

export function useChartZoom(length: number, resetKey: string) {
  const [range, setRangeState] = React.useState<ChartZoomRange>(() => ({ start: 0, end: Math.max(length - 1, 0) }));
  const previousLengthRef = React.useRef(length);
  const userChangedRef = React.useRef(false);

  const setRange = React.useCallback((nextRange: ChartZoomRange) => {
    userChangedRef.current = true;
    setRangeState(clampChartZoomRange(nextRange, length));
  }, [length]);

  React.useEffect(() => {
    previousLengthRef.current = length;
    userChangedRef.current = false;
    setRangeState({ start: 0, end: Math.max(length - 1, 0) });
  }, [resetKey]);

  React.useEffect(() => {
    const previousLength = previousLengthRef.current;
    previousLengthRef.current = length;
    const previousMax = Math.max(previousLength - 1, 0);
    const max = Math.max(length - 1, 0);

    setRangeState((current) => {
      const wasAtEnd = current.end >= previousMax;
      const wasFullRange = current.start === 0 && wasAtEnd;

      if (!userChangedRef.current || wasFullRange) {
        return { start: 0, end: max };
      }

      if (wasAtEnd) {
        const width = current.end - current.start;
        return clampChartZoomRange({ start: max - width, end: max }, length);
      }

      return clampChartZoomRange(current, length);
    });
  }, [length]);

  return [range, setRange] as const;
}

export function ChartZoomControl({
  count,
  end,
  endLabel,
  onChange,
  start,
  startLabel,
  t,
}: {
  count: number;
  end: number;
  endLabel?: string;
  onChange: (range: ChartZoomRange) => void;
  start: number;
  startLabel?: string;
  t: (key: TranslationKey) => string;
}) {
  if (count < 2) return null;
  const max = count - 1;
  const safeStart = Math.max(0, Math.min(start, max - 1));
  const safeEnd = Math.max(safeStart + 1, Math.min(end, max));
  const startPct = (safeStart / max) * 100;
  const endPct = (safeEnd / max) * 100;
  const rangeWidth = safeEnd - safeStart;

  function pointToIndex(clientX: number, element: HTMLElement) {
    const rect = element.getBoundingClientRect();
    const ratio = Math.max(0, Math.min(1, (clientX - rect.left) / Math.max(rect.width, 1)));
    return Math.round(ratio * max);
  }

  function moveWindow(centerIndex: number) {
    const nextStart = Math.max(0, Math.min(centerIndex - Math.round(rangeWidth / 2), max - rangeWidth));
    onChange({ start: nextStart, end: nextStart + rangeWidth });
  }

  function handleTrackPointerDown(event: React.PointerEvent<HTMLDivElement>) {
    if (event.button !== 0 || event.target instanceof HTMLInputElement) return;
    event.preventDefault();
    const track = event.currentTarget;
    const initialIndex = pointToIndex(event.clientX, track);
    const dragOffset = initialIndex >= safeStart && initialIndex <= safeEnd
      ? initialIndex - safeStart
      : Math.round(rangeWidth / 2);
    if (initialIndex < safeStart || initialIndex > safeEnd) moveWindow(initialIndex);

    const handlePointerMove = (moveEvent: PointerEvent) => {
      const nextIndex = pointToIndex(moveEvent.clientX, track);
      const nextStart = Math.max(0, Math.min(nextIndex - dragOffset, max - rangeWidth));
      onChange({ start: nextStart, end: nextStart + rangeWidth });
    };
    const handlePointerUp = () => {
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerup", handlePointerUp);
    };

    window.addEventListener("pointermove", handlePointerMove);
    window.addEventListener("pointerup", handlePointerUp, { once: true });
  }

  return (
    <div className="chart-zoom-control">
      <div className="chart-zoom-head">
        <span>{t("chartZoom")}</span>
        <div>
          <button
            disabled={safeStart === 0 && safeEnd === max}
            onClick={() => onChange({ start: 0, end: max })}
            type="button"
          >
            {t("chartZoomReset")}
          </button>
          <strong>{safeStart + 1}-{safeEnd + 1} / {count}</strong>
        </div>
      </div>
      <div
        className="chart-zoom-track"
        onPointerDown={handleTrackPointerDown}
        style={{
          "--zoom-end": `${endPct}%`,
          "--zoom-start": `${startPct}%`,
        } as React.CSSProperties}
      >
        <input
          aria-label={t("chartZoomStart")}
          max={max}
          min={0}
          onChange={(event) => onChange({ start: Math.min(Number(event.target.value), safeEnd - 1), end: safeEnd })}
          type="range"
          value={safeStart}
        />
        <input
          aria-label={t("chartZoomEnd")}
          max={max}
          min={0}
          onChange={(event) => onChange({ start: safeStart, end: Math.max(Number(event.target.value), safeStart + 1) })}
          type="range"
          value={safeEnd}
        />
      </div>
      {(startLabel || endLabel) ? (
        <div className="chart-zoom-foot">
          <span>{startLabel}</span>
          <span>{endLabel}</span>
        </div>
      ) : null}
    </div>
  );
}

function numericValue(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export function downsampleChartRows<T extends ChartRow>(
  rows: T[],
  keys: string[],
  maxPoints = 1400,
) {
  if (rows.length <= maxPoints) return rows;
  const usefulKeys = keys.length > 0 ? keys : Object.keys(rows[0] ?? {});
  const bucketCount = Math.max(1, Math.floor(maxPoints / 4));
  const bucketSize = Math.ceil(rows.length / bucketCount);
  const selected = new Map<number, T>();

  for (let start = 0; start < rows.length; start += bucketSize) {
    const end = Math.min(start + bucketSize, rows.length);
    let minIndex = start;
    let maxIndex = start;
    let minValue = Number.POSITIVE_INFINITY;
    let maxValue = Number.NEGATIVE_INFINITY;

    for (let index = start; index < end; index += 1) {
      const values = usefulKeys
        .map((key) => numericValue(rows[index][key]))
        .filter((value): value is number => value != null);
      if (values.length === 0) continue;
      const rowMin = Math.min(...values);
      const rowMax = Math.max(...values);
      if (rowMin < minValue) {
        minValue = rowMin;
        minIndex = index;
      }
      if (rowMax > maxValue) {
        maxValue = rowMax;
        maxIndex = index;
      }
    }

    selected.set(start, rows[start]);
    selected.set(minIndex, rows[minIndex]);
    selected.set(maxIndex, rows[maxIndex]);
    selected.set(end - 1, rows[end - 1]);
  }

  return Array.from(selected.entries())
    .sort(([a], [b]) => a - b)
    .map(([, row]) => row);
}
