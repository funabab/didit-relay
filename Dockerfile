FROM oven/bun:1.4-slim
WORKDIR /app

COPY package.json ./
RUN bun install --production

COPY src/ ./src/

ENV NODE_ENV=production
ENV PORT=8080

RUN mkdir -p /app/.cache/media && chown -R bun:bun /app
USER bun

EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD bun -e "fetch('http://localhost:'+(process.env['PORT']||'8080')+'/healthz').then((r)=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"

CMD ["bun", "src/server.ts"]
