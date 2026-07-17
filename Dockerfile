# --- deps: instala dependencias de node ---
FROM node:22-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

# --- builder: compila la app Next.js ---
FROM node:22-slim AS builder
WORKDIR /app
# Next.js inyecta las variables NEXT_PUBLIC_* en el bundle del cliente en
# tiempo de build, no de runtime. El panel de deploy usado no expone "build
# args" para builds con Dockerfile, así que van fijas acá — son públicas por
# diseño (viajan al navegador de todos modos), no son secretas. El resto de
# las variables (keys privadas) solo se necesitan en runtime y se configuran
# como variables de entorno normales en el panel.
ENV NEXT_PUBLIC_SUPABASE_URL=https://lpuclnvvdtobremsigih.supabase.co
ENV NEXT_PUBLIC_SUPABASE_ANON_KEY=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImxwdWNsbnZ2ZHRvYnJlbXNpZ2loIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODQyNTM2NTIsImV4cCI6MjA5OTgyOTY1Mn0.4JkRnCdabsrg4c6n1lmkJ4aumYlF1fxjSlFNKQmp__E
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npm run build

# --- runner: imagen final con ffmpeg, corre server + worker ---
FROM node:22-slim AS runner
WORKDIR /app
ENV NODE_ENV=production

RUN apt-get update \
    && apt-get install -y --no-install-recommends ffmpeg fonts-dejavu-core \
    && rm -rf /var/lib/apt/lists/*

COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/.next ./.next
COPY --from=builder /app/public ./public
COPY --from=builder /app/package.json ./package.json
COPY --from=builder /app/next.config.ts ./next.config.ts
COPY --from=builder /app/tsconfig.json ./tsconfig.json
COPY --from=builder /app/worker.ts ./worker.ts
COPY --from=builder /app/src ./src
COPY --from=builder /app/start.sh ./start.sh

RUN chmod +x ./start.sh

EXPOSE 3000
CMD ["./start.sh"]
