"use client";

import { useRef, useState, useTransition } from "react";
import type { DragEvent } from "react";
import type { Segment } from "@/lib/types";
import {
  updateSegmentsContent,
  reorderSegments,
  replaceSegmentImage,
  uploadSegmentImage,
} from "./actions";

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
  const [order, setOrder] = useState<string[]>(segments.map((s) => s.id));
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [busyIds, setBusyIds] = useState<Set<string>>(new Set());
  const [imageErrors, setImageErrors] = useState<Record<string, string>>({});
  const dragIndexRef = useRef<number | null>(null);

  // El orden mostrado sigue a la prop (fuente de verdad del servidor) salvo
  // mientras hay un drag en curso, que se maneja solo en el cliente. Se
  // ajusta durante el render (no en un efecto) siguiendo el patrón
  // recomendado por React para "resetear estado cuando cambia una prop".
  const segmentsKey = segments.map((s) => s.id).join(",");
  const [prevSegmentsKey, setPrevSegmentsKey] = useState(segmentsKey);
  if (segmentsKey !== prevSegmentsKey) {
    setPrevSegmentsKey(segmentsKey);
    setOrder(segments.map((s) => s.id));
  }

  const segmentById = new Map(segments.map((s) => [s.id, s]));

  function updateRow(id: string, patch: Partial<Row>) {
    setSaved(false);
    setRows((prev) => prev.map((r) => (r.id === id ? { ...r, ...patch } : r)));
  }

  function setBusy(id: string, busy: boolean) {
    setBusyIds((prev) => {
      const next = new Set(prev);
      if (busy) next.add(id);
      else next.delete(id);
      return next;
    });
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

  function handleDragStart(index: number) {
    dragIndexRef.current = index;
  }

  function handleDragOver(e: DragEvent<HTMLDivElement>, index: number) {
    e.preventDefault();
    const from = dragIndexRef.current;
    if (from === null || from === index) return;
    setOrder((prev) => {
      const next = [...prev];
      const [moved] = next.splice(from, 1);
      next.splice(index, 0, moved);
      return next;
    });
    dragIndexRef.current = index;
  }

  function handleDrop() {
    dragIndexRef.current = null;
    startTransition(async () => {
      await reorderSegments(projectId, order);
    });
  }

  async function handleReplaceImage(segmentId: string) {
    setBusy(segmentId, true);
    setImageErrors((prev) => ({ ...prev, [segmentId]: "" }));
    const result = await replaceSegmentImage(projectId, segmentId);
    if (result.error) {
      setImageErrors((prev) => ({ ...prev, [segmentId]: result.error! }));
    }
    setBusy(segmentId, false);
  }

  async function handleUploadImage(segmentId: string, file: File) {
    setBusy(segmentId, true);
    setImageErrors((prev) => ({ ...prev, [segmentId]: "" }));
    const formData = new FormData();
    formData.append("file", file);
    const result = await uploadSegmentImage(projectId, segmentId, formData);
    if (result.error) {
      setImageErrors((prev) => ({ ...prev, [segmentId]: result.error! }));
    }
    setBusy(segmentId, false);
  }

  const totalSeconds = rows.reduce(
    (acc, r) => acc + (Number(r.estimated_duration_seconds) || 0),
    0,
  );

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between">
        <span className="text-sm text-foreground/60">
          Segmentos ({segments.length}) · duración total estimada:{" "}
          {Math.floor(totalSeconds / 60)} min {totalSeconds % 60}s
        </span>
        <span className="text-xs text-foreground/40">
          Arrastrá las tarjetas para reordenar
        </span>
      </div>

      <div className="flex gap-3 overflow-x-auto pb-2">
        {order.map((id, index) => {
          const segment = segmentById.get(id);
          const row = rows.find((r) => r.id === id);
          if (!segment || !row) return null;
          const busy = busyIds.has(id);

          return (
            <div
              key={id}
              draggable
              onDragStart={() => handleDragStart(index)}
              onDragOver={(e) => handleDragOver(e, index)}
              onDrop={handleDrop}
              onDragEnd={() => {
                dragIndexRef.current = null;
              }}
              className="flex w-56 shrink-0 cursor-grab flex-col gap-2 rounded-md border border-black/10 bg-background p-2 active:cursor-grabbing"
            >
              <div className="flex items-center justify-between text-xs text-foreground/50">
                <span>Segmento {index + 1}</span>
                <span aria-hidden>⠿</span>
              </div>

              <div className="flex h-28 items-center justify-center overflow-hidden rounded-md bg-black/5">
                {segment.image_url ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={segment.image_url}
                    alt=""
                    draggable={false}
                    className="h-full w-full object-cover"
                  />
                ) : (
                  <span className="text-xs text-foreground/30">
                    Sin imagen
                  </span>
                )}
              </div>

              <div className="flex gap-2 text-xs">
                <button
                  type="button"
                  onClick={() => handleReplaceImage(id)}
                  disabled={busy}
                  className="flex-1 rounded border border-black/10 py-1 disabled:opacity-50"
                >
                  {busy ? "..." : "Buscar otra"}
                </button>
                <label className="flex-1 cursor-pointer rounded border border-black/10 py-1 text-center">
                  Subir
                  <input
                    type="file"
                    accept="image/*"
                    className="hidden"
                    disabled={busy}
                    onChange={(e) => {
                      const file = e.target.files?.[0];
                      if (file) handleUploadImage(id, file);
                      e.target.value = "";
                    }}
                  />
                </label>
              </div>
              {imageErrors[id] && (
                <p className="text-xs text-red-600">{imageErrors[id]}</p>
              )}

              {segment.audio_url && (
                <audio controls src={segment.audio_url} className="h-8 w-full" />
              )}

              <textarea
                value={row.text}
                onChange={(e) => updateRow(id, { text: e.target.value })}
                rows={3}
                className="rounded-md border border-black/10 px-2 py-1 text-xs"
              />
            </div>
          );
        })}
      </div>

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
