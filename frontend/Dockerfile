# ─── AEGIS GLOBAL — Frontend Dockerfile (pre-built) ──────────────────────────
# Uses pre-built dist/ folder — no npm install or vite build needed in Docker

FROM nginx:1.27-alpine

RUN rm -f /etc/nginx/conf.d/default.conf

COPY dist/ /usr/share/nginx/html/
COPY nginx.conf /etc/nginx/nginx.conf

EXPOSE 3000

HEALTHCHECK --interval=10s --timeout=5s --retries=3 \
  CMD wget -qO- http://127.0.0.1:3000/nginx-health || exit 1

CMD ["nginx", "-g", "daemon off;"]
