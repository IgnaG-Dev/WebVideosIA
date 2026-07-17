"use client";

import { useRef, useState, useTransition } from "react";
import type { DragEvent } from "react";
import type { Segment, SegmentAnimation, SegmentTransition } from "@/lib/types";
import { reorderSegments } from "./actions";

const ANIMATION_LABELS: Record<SegmentAnimation, string> = {
  none: "Sin animación",
  zoom_in: "Acercar (zoom in)",
  zoom_out: "Alejar (zoom out)",
  pan_left: "Paneo a la izquierda",
  pan_right: "Paneo a la derecha",
  pan_up: "Paneo hacia arriba",
  pan_down: "Paneo hacia abajo",
};

const TRANSITION_LABELS: Record<SegmentTransition, string> = {
  cut: "Corte directo",
  crossfade: "Crossfade",
};

// Editor de solo reordenar: el contenido de cada segmento (imagen/video,
// texto, animación, transición) se define al generar el guion y no se
// puede editar acá — lo único que el usuario puede cambiar es el orden.
export function SegmentsEditor({
  projectId,
  segments,
}: {
  projectId: string;
  segments: Segment[];
}) {
  const [order, setOrder] = useState<string[]>(segments.map((s) => s.id));
  const [, startTransition] = useTransition();
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

  const totalSeconds = segments.reduce(
    (acc, s) => acc + (Number(s.estimated_duration_seconds) || 0),
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
          if (!segment) return null;

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
              className="flex w-64 shrink-0 cursor-grab flex-col gap-2 rounded-md border border-black/10 bg-background p-2 active:cursor-grabbing"
            >
              <div className="flex items-center justify-between text-xs text-foreground/50">
                <span>Segmento {index + 1}</span>
                <span aria-hidden>⠿</span>
              </div>

              <div className="flex h-28 items-center justify-center overflow-hidden rounded-md bg-black/5">
                {segment.image_url && segment.media_type === "video" ? (
                  <video
                    src={segment.image_url}
                    muted
                    loop
                    className="h-full w-full object-cover"
                  />
                ) : segment.image_url ? (
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

              <div className="flex flex-col gap-0.5 text-xs text-foreground/50">
                <span>Animación: {ANIMATION_LABELS[segment.animation]}</span>
                {index > 0 && (
                  <span>Entrada: {TRANSITION_LABELS[segment.transition]}</span>
                )}
              </div>

              {segment.audio_url && (
                <audio controls src={segment.audio_url} className="h-8 w-full" />
              )}

              <p className="rounded-md border border-black/10 px-2 py-1 text-xs text-foreground/80">
                {segment.text}
              </p>
            </div>
          );
        })}
      </div>
    </div>
  );
}
