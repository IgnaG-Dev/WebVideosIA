import "server-only";

export type MediaType = "image" | "video";
export type MediaProvider = "pexels" | "pixabay" | "gemini";

export type StockMediaResult = {
  url: string;
  type: MediaType;
  provider: MediaProvider;
};

interface StockMediaSource {
  provider: MediaProvider;
  searchImage(keywords: string, page: number): Promise<StockMediaResult | null>;
  searchVideo(keywords: string, page: number): Promise<StockMediaResult | null>;
}

const pexelsSource: StockMediaSource = {
  provider: "pexels",

  async searchImage(keywords, page) {
    const apiKey = process.env.PEXELS_API_KEY;
    if (!apiKey) return null;

    const res = await fetch(
      `https://api.pexels.com/v1/search?query=${encodeURIComponent(keywords)}&per_page=1&page=${page}&orientation=landscape`,
      { headers: { Authorization: apiKey } },
    );
    if (!res.ok) return null;

    const data = (await res.json()) as {
      photos?: Array<{ src: { large: string } }>;
    };
    const photo = data.photos?.[0];
    if (!photo) return null;

    return { url: photo.src.large, type: "image", provider: "pexels" };
  },

  async searchVideo(keywords, page) {
    const apiKey = process.env.PEXELS_API_KEY;
    if (!apiKey) return null;

    const res = await fetch(
      `https://api.pexels.com/videos/search?query=${encodeURIComponent(keywords)}&per_page=1&page=${page}&orientation=landscape`,
      { headers: { Authorization: apiKey } },
    );
    if (!res.ok) return null;

    const data = (await res.json()) as {
      videos?: Array<{
        video_files: Array<{ link: string; quality: string; width: number }>;
      }>;
    };
    const video = data.videos?.[0];
    if (!video) return null;

    const file =
      video.video_files.find((f) => f.quality === "sd" && f.width <= 960) ??
      video.video_files[0];
    if (!file) return null;

    return { url: file.link, type: "video", provider: "pexels" };
  },
};

const pixabaySource: StockMediaSource = {
  provider: "pixabay",

  async searchImage(keywords, page) {
    const apiKey = process.env.PIXABAY_API_KEY;
    if (!apiKey) return null;

    const res = await fetch(
      `https://pixabay.com/api/?key=${apiKey}&q=${encodeURIComponent(keywords)}&image_type=photo&per_page=3&page=${page}&safesearch=true`,
    );
    if (!res.ok) return null;

    const data = (await res.json()) as {
      hits?: Array<{ largeImageURL: string }>;
    };
    const hit = data.hits?.[0];
    if (!hit) return null;

    return { url: hit.largeImageURL, type: "image", provider: "pixabay" };
  },

  async searchVideo(keywords, page) {
    const apiKey = process.env.PIXABAY_API_KEY;
    if (!apiKey) return null;

    const res = await fetch(
      `https://pixabay.com/api/videos/?key=${apiKey}&q=${encodeURIComponent(keywords)}&per_page=3&page=${page}&safesearch=true`,
    );
    if (!res.ok) return null;

    const data = (await res.json()) as {
      hits?: Array<{
        videos: { medium?: { url: string }; small?: { url: string } };
      }>;
    };
    const hit = data.hits?.[0];
    const url = hit?.videos.medium?.url ?? hit?.videos.small?.url;
    if (!url) return null;

    return { url, type: "video", provider: "pixabay" };
  },
};

// Reservado para una fase futura: generación de imágenes/video con la API
// de Gemini (variable GEMINI_API_KEY, todavía no usada). Para sumarla más
// adelante: implementar acá un StockMediaSource más y agregarlo a SOURCES
// — el resto del flujo (worker, ffmpeg) no necesita cambios porque solo
// conoce la forma StockMediaResult { url, type, provider }.
// const geminiSource: StockMediaSource = { provider: "gemini", ... };

const SOURCES: StockMediaSource[] = [pexelsSource, pixabaySource];

/**
 * Busca contenido visual real que coincida con las palabras clave de un
 * segmento, probando los proveedores en orden. `preferredType` decide si se
 * intenta primero imagen o video (si no hay resultados de ese tipo, cae al
 * otro). `page` permite pedir un resultado distinto al de una búsqueda
 * anterior con las mismas palabras clave (ver `searchDifferentMedia`).
 */
export async function searchMedia(
  keywords: string,
  options?: { page?: number; preferredType?: MediaType },
): Promise<StockMediaResult | null> {
  const page = options?.page ?? 1;
  const typeOrder: MediaType[] =
    options?.preferredType === "video" ? ["video", "image"] : ["image", "video"];

  for (const type of typeOrder) {
    for (const source of SOURCES) {
      const result =
        type === "image"
          ? await source.searchImage(keywords, page)
          : await source.searchVideo(keywords, page);
      if (result) return result;
    }
  }
  return null;
}

/**
 * Como searchMedia, pero pide una página al azar (dentro de un rango chico)
 * para no traer siempre el mismo resultado top — pensado para "buscar otra
 * imagen/video" sobre un segmento que ya tiene uno.
 */
export async function searchDifferentMedia(
  keywords: string,
  preferredType?: MediaType,
): Promise<StockMediaResult | null> {
  const page = 1 + Math.floor(Math.random() * 5);
  return searchMedia(keywords, { page, preferredType });
}

export async function downloadMedia(
  url: string,
): Promise<{ bytes: Uint8Array; contentType: string }> {
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`No se pudo descargar el media (${res.status}): ${url}`);
  }
  const contentType =
    res.headers.get("content-type") ?? "application/octet-stream";
  const bytes = new Uint8Array(await res.arrayBuffer());
  return { bytes, contentType };
}

const SPANISH_STOPWORDS = new Set([
  "el", "la", "los", "las", "un", "una", "unos", "unas", "de", "del", "al",
  "a", "en", "y", "o", "u", "que", "es", "son", "para", "por", "con", "su",
  "sus", "se", "lo", "le", "les", "como", "mas", "pero", "si", "no", "ya",
  "muy", "esto", "esta", "este", "estos", "estas", "eso", "esa", "ese",
  "tambien", "cuando", "donde", "porque", "sobre", "entre", "hay", "ser",
  "estar", "asi", "sin", "todo", "toda", "todos", "todas", "nos", "les",
]);

/** Deriva palabras clave de búsqueda a partir del texto narrado de un segmento. */
export function extractKeywords(text: string, maxWords = 6): string {
  const words = text
    .toLowerCase()
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 2 && !SPANISH_STOPWORDS.has(w));

  const keywords = words.slice(0, maxWords).join(" ");
  return keywords || text.slice(0, 60);
}

export function extensionFromContentType(contentType: string): string {
  const map: Record<string, string> = {
    "image/jpeg": "jpg",
    "image/png": "png",
    "image/webp": "webp",
    "video/mp4": "mp4",
  };
  return map[contentType] ?? contentType.split("/")[1]?.split(";")[0] ?? "bin";
}
