import type { ProjectStatus } from "./types";

export const PROJECT_STATUS_LABEL: Record<ProjectStatus, string> = {
  draft: "Borrador",
  generating_script: "Generando guion",
  script_ready: "Guion listo",
  queued: "En cola",
  generating_images: "Generando imágenes",
  generating_audio: "Generando audio",
  assembling: "Armando video",
  done: "Listo",
  error: "Error",
};
