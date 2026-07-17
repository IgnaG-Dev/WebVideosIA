"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";

const POLL_INTERVAL_MS = 4000;

const IN_PROGRESS_STATUSES = new Set([
  "generating_script",
  "queued",
  "generating_images",
  "generating_audio",
  "assembling",
]);

const IN_PROGRESS_LABEL: Record<string, string> = {
  generating_script: "Generando tu guion...",
  queued: "Tu video quedó en cola para generarse...",
  generating_images: "Buscando imágenes para cada segmento...",
  generating_audio: "Generando el audio de cada segmento...",
  assembling: "Armando el video final...",
};

// Detalle de lo que está pasando dentro de un status, para que los pasos
// que antes eran una caja negra (continuar el guion, renderizar los clips
// con animación, codificar, subir) tengan feedback visible.
const PROGRESS_STEP_LABEL: Record<string, string> = {
  script: "Escribiendo el guion...",
  continuing_script: "El guion quedó corto, extendiéndolo...",
  segmenting: "Dividiendo el guion en segmentos...",
  clips: "Renderizando la animación de cada segmento...",
  encoding: "Uniendo los segmentos y codificando el video...",
  uploading: "Subiendo el video final...",
};

type StatusResponse = {
  status: string;
  progress_step: string | null;
  progress_current: number;
  progress_total: number;
  segments: {
    total: number;
    images_ready: number;
    audios_ready: number;
    errors: number;
  };
};

export function ProjectProgress({
  projectId,
  initialStatus,
}: {
  projectId: string;
  initialStatus: string;
}) {
  const router = useRouter();
  const [data, setData] = useState<StatusResponse | null>(null);
  const stoppedRef = useRef(false);

  useEffect(() => {
    stoppedRef.current = false;

    async function poll() {
      if (stoppedRef.current) return;

      try {
        const res = await fetch(`/api/projects/${projectId}/status`, {
          cache: "no-store",
        });
        if (res.ok) {
          const json: StatusResponse = await res.json();
          setData(json);
          if (!IN_PROGRESS_STATUSES.has(json.status)) {
            stoppedRef.current = true;
            router.refresh();
            return;
          }
        }
      } catch {
        // Error de red puntual: se reintenta en el próximo tick.
      }

      if (!stoppedRef.current) {
        setTimeout(poll, POLL_INTERVAL_MS);
      }
    }

    poll();

    return () => {
      stoppedRef.current = true;
    };
  }, [projectId, router]);

  if (!IN_PROGRESS_STATUSES.has(initialStatus)) {
    return null;
  }

  const currentStatus = data?.status ?? initialStatus;
  const segments = data?.segments;
  const progressStep = data?.progress_step ?? null;

  return (
    <div className="flex flex-col gap-3 rounded-md bg-amber-50 px-4 py-3 text-sm text-amber-800">
      <p>{IN_PROGRESS_LABEL[currentStatus] ?? "Procesando..."}</p>
      {progressStep && (
        <div className="flex flex-col gap-1">
          <span className="text-xs">
            {PROGRESS_STEP_LABEL[progressStep] ?? progressStep}
          </span>
          {data && data.progress_total > 1 && (
            <ProgressBar
              label={`${data.progress_current}/${data.progress_total}`}
              value={data.progress_current}
              total={data.progress_total}
            />
          )}
        </div>
      )}
      {segments && segments.total > 0 && (
        <div className="flex flex-col gap-2">
          <ProgressBar
            label={`Imágenes: ${segments.images_ready}/${segments.total}`}
            value={segments.images_ready}
            total={segments.total}
          />
          <ProgressBar
            label={`Audios: ${segments.audios_ready}/${segments.total}`}
            value={segments.audios_ready}
            total={segments.total}
          />
          {segments.errors > 0 && (
            <p className="text-xs text-red-700">
              {segments.errors} segmento(s) con error.
            </p>
          )}
        </div>
      )}
    </div>
  );
}

function ProgressBar({
  label,
  value,
  total,
}: {
  label: string;
  value: number;
  total: number;
}) {
  const pct = total > 0 ? Math.round((value / total) * 100) : 0;
  return (
    <div className="flex flex-col gap-1">
      <span className="text-xs">{label}</span>
      <div className="h-2 w-full overflow-hidden rounded-full bg-amber-200">
        <div
          className="h-full bg-amber-600 transition-all"
          style={{ width: `${pct}%` }}
        />
      </div>
    </div>
  );
}
