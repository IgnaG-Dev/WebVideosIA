export type ScriptMode = "manual" | "ia";

export type ScriptLanguage = "es" | "en";

export type MediaPreference = "image" | "video" | "gemini";

export type SegmentAnimation =
  | "none"
  | "zoom_in"
  | "zoom_out"
  | "pan_left"
  | "pan_right"
  | "pan_up"
  | "pan_down";

export type SegmentTransition = "cut" | "crossfade";

export type ProjectStatus =
  | "draft"
  | "generating_script"
  | "script_ready"
  | "queued"
  | "generating_images"
  | "generating_audio"
  | "assembling"
  | "done"
  | "error";

export type SegmentStatus =
  | "pending"
  | "image_ready"
  | "audio_ready"
  | "ready"
  | "error";

export type Segment = {
  id: string;
  project_id: string;
  order_index: number;
  text: string;
  estimated_duration_seconds: number;
  image_url: string | null;
  media_type: "image" | "video" | null;
  media_provider: "pexels" | "pixabay" | "gemini" | null;
  audio_url: string | null;
  animation: SegmentAnimation;
  transition: SegmentTransition;
  status: SegmentStatus;
  error_message: string | null;
  created_at: string;
  updated_at: string;
};

export type Project = {
  id: string;
  user_id: string;
  title: string;
  script_mode: ScriptMode;
  status: ProjectStatus;
  target_duration_minutes: number;
  media_preference: MediaPreference;
  script_language: ScriptLanguage;
  subtitles_enabled: boolean;
  topic: string | null;
  tone: string | null;
  audience: string | null;
  full_script: string | null;
  video_url: string | null;
  error_message: string | null;
  created_at: string;
  updated_at: string;
};
