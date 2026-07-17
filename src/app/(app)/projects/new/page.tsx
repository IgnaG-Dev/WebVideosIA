"use client";

import { useActionState, useState } from "react";
import { createProject, type CreateProjectState } from "./actions";

const initialState: CreateProjectState = { error: null };

export default function NewProjectPage() {
  const [mode, setMode] = useState<"manual" | "ia">("manual");
  const [state, formAction, pending] = useActionState(
    createProject,
    initialState,
  );

  return (
    <div className="mx-auto flex max-w-xl flex-col gap-6">
      <h1 className="text-2xl font-semibold">Nuevo proyecto</h1>

      <form action={formAction} className="flex flex-col gap-5">
        <label className="flex flex-col gap-1 text-sm">
          Título
          <input
            name="title"
            required
            className="rounded-md border border-black/10 px-3 py-2"
          />
        </label>

        <div className="flex flex-col gap-2 text-sm">
          <span>Modo de guion</span>
          <div className="flex gap-4">
            <label className="flex items-center gap-2">
              <input
                type="radio"
                name="script_mode"
                value="manual"
                checked={mode === "manual"}
                onChange={() => setMode("manual")}
              />
              Manual
            </label>
            <label className="flex items-center gap-2">
              <input
                type="radio"
                name="script_mode"
                value="ia"
                checked={mode === "ia"}
                onChange={() => setMode("ia")}
              />
              Con IA
            </label>
          </div>
        </div>

        <label className="flex flex-col gap-1 text-sm">
          Duración objetivo (minutos)
          <input
            type="number"
            name="target_duration_minutes"
            min={5}
            max={30}
            defaultValue={10}
            required
            className="rounded-md border border-black/10 px-3 py-2"
          />
        </label>

        <div className="flex flex-col gap-2 text-sm">
          <span>Contenido visual de los segmentos</span>
          <div className="flex gap-4">
            <label className="flex items-center gap-2">
              <input
                type="radio"
                name="media_preference"
                value="image"
                defaultChecked
              />
              Imágenes
            </label>
            <label className="flex items-center gap-2">
              <input type="radio" name="media_preference" value="video" />
              Videos
            </label>
          </div>
          <span className="text-xs text-foreground/50">
            Del banco de Pexels/Pixabay. Si no encuentra del tipo elegido para
            algún segmento, usa el otro.
          </span>
        </div>

        {mode === "manual" ? (
          <label className="flex flex-col gap-1 text-sm">
            Guion completo
            <textarea
              name="full_script"
              rows={10}
              required
              className="rounded-md border border-black/10 px-3 py-2"
            />
          </label>
        ) : (
          <>
            <label className="flex flex-col gap-1 text-sm">
              Tema
              <input
                name="topic"
                required
                className="rounded-md border border-black/10 px-3 py-2"
              />
            </label>
            <label className="flex flex-col gap-1 text-sm">
              Tono
              <input
                name="tone"
                required
                placeholder="Ej: informal, inspirador, educativo..."
                className="rounded-md border border-black/10 px-3 py-2"
              />
            </label>
            <label className="flex flex-col gap-1 text-sm">
              Público
              <input
                name="audience"
                required
                placeholder="Ej: jóvenes interesados en tecnología"
                className="rounded-md border border-black/10 px-3 py-2"
              />
            </label>
          </>
        )}

        {state.error && <p className="text-sm text-red-600">{state.error}</p>}

        <button
          type="submit"
          disabled={pending}
          className="rounded-md bg-foreground px-4 py-2 text-sm font-medium text-background disabled:opacity-60"
        >
          {pending ? "Creando..." : "Crear proyecto"}
        </button>
      </form>
    </div>
  );
}
