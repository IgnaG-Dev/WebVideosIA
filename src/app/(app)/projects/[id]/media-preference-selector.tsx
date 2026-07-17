"use client";

import { useTransition } from "react";
import type { MediaPreference } from "@/lib/types";
import { updateMediaPreference } from "./actions";

export function MediaPreferenceSelector({
  projectId,
  mediaPreference,
}: {
  projectId: string;
  mediaPreference: MediaPreference;
}) {
  const [isPending, startTransition] = useTransition();

  function handleChange(value: MediaPreference) {
    startTransition(async () => {
      await updateMediaPreference(projectId, value);
    });
  }

  return (
    <div className="flex items-center gap-4 text-sm">
      <span className="text-foreground/60">
        Contenido visual para &quot;Generar video&quot;:
      </span>
      <label className="flex items-center gap-1">
        <input
          type="radio"
          name="media_preference_select"
          checked={mediaPreference === "image"}
          disabled={isPending}
          onChange={() => handleChange("image")}
        />
        Imágenes
      </label>
      <label className="flex items-center gap-1">
        <input
          type="radio"
          name="media_preference_select"
          checked={mediaPreference === "video"}
          disabled={isPending}
          onChange={() => handleChange("video")}
        />
        Videos
      </label>
    </div>
  );
}
