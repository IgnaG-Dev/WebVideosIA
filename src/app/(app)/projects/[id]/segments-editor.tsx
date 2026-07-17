"use client";

import { useState, useTransition } from "react";
import type { Segment } from "@/lib/types";
import { moveSegment, updateSegmentsContent } from "./actions";

type Row = { id: string; text: string; estimated_duration_seconds: number };

export function SegmentsEditor({
  projectId,
  segments,
}: {
  projectId: string;
  segments: Segment[];
}) {
  const [rows, setRows] = useState<Row[]>(
    segments.map((s) => ({
      id: s.id,
      text: s.text,
      estimated_duration_seconds: s.estimated_duration_seconds,
    })),
  );
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  function updateRow(id: string, patch: Partial<Row>) {
    setSaved(false);
    setRows((prev) => prev.map((r) => (r.id === id ? { ...r, ...patch } : r)));
  }

  function handleSave() {
    setError(null);
    startTransition(async () => {
      const result = await updateSegmentsContent(projectId, rows);
      if (result.error) {
        setError(result.error);
      } else {
        setSaved(true);
      }
    });
  }

  const totalSeconds = rows.reduce(
    (acc, r) => acc + (Number(r.estimated_duration_seconds) || 0),
    0,
  );

  return (
    <div className="flex flex-col gap-3">
      <span className="text-sm text-foreground/60">
        Segmentos ({segments.length}) · duración total estimada:{" "}
        {Math.floor(totalSeconds / 60)} min {totalSeconds % 60}s
      </span>

      <ol className="flex flex-col gap-2">
        {segments.map((segment, index) => {
          const row = rows.find((r) => r.id === segment.id);
          if (!row) return null;

          return (
            <li
              key={segment.id}
              className="flex flex-col gap-2 rounded-md border border-black/10 px-3 py-2"
            >
              <div className="flex items-center justify-between text-xs text-foreground/50">
                <span>Segmento {index + 1}</span>
                <div className="flex items-center gap-3">
                  <form
                    action={moveSegment.bind(
                      null,
                      projectId,
                      segment.id,
                      "up",
                    )}
                  >
                    <button
                      type="submit"
                      disabled={index === 0}
                      aria-label="Mover arriba"
                      className="disabled:opacity-30"
                    >
                      ↑
                    </button>
                  </form>
                  <form
                    action={moveSegment.bind(
                      null,
                      projectId,
                      segment.id,
                      "down",
                    )}
                  >
                    <button
                      type="submit"
                      disabled={index === segments.length - 1}
                      aria-label="Mover abajo"
                      className="disabled:opacity-30"
                    >
                      ↓
                    </button>
                  </form>
                </div>
              </div>

              <textarea
                value={row.text}
                onChange={(e) =>
                  updateRow(segment.id, { text: e.target.value })
                }
                rows={2}
                className="rounded-md border border-black/10 px-2 py-1 text-sm"
              />

              <label className="flex items-center gap-2 text-xs text-foreground/60">
                Duración (segundos)
                <input
                  type="number"
                  min={1}
                  value={row.estimated_duration_seconds}
                  onChange={(e) =>
                    updateRow(segment.id, {
                      estimated_duration_seconds: Number(e.target.value),
                    })
                  }
                  className="w-20 rounded-md border border-black/10 px-2 py-1"
                />
              </label>
            </li>
          );
        })}
      </ol>

      {error && <p className="text-sm text-red-600">{error}</p>}
      {saved && !isPending && (
        <p className="text-sm text-green-600">Cambios guardados.</p>
      )}

      <button
        type="button"
        onClick={handleSave}
        disabled={isPending}
        className="self-start rounded-md border border-black/10 px-4 py-2 text-sm font-medium disabled:opacity-60"
      >
        {isPending ? "Guardando..." : "Guardar cambios"}
      </button>
    </div>
  );
}
