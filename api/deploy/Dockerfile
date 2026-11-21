# Practice inference API. Build from the api/ folder:
#   docker build -f deploy/Dockerfile -t showdown-practice-api .
# The installer compiles poke-engine with a private Rust toolchain and removes it afterwards.
FROM node:24-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates build-essential tar \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /opt/api
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund
COPY lock.json install.js protocol.js server.js resources.js client.js ./
COPY worker ./worker
COPY metamon ./metamon
ARG WITH_METAMON=0
RUN node install.js --dir /opt/api/runtime
RUN if [ "$WITH_METAMON" = "1" ]; then node metamon/install.js --dir /opt/api/metamon-runtime; fi
RUN useradd --uid 10001 --create-home api
RUN mkdir -p /opt/api/metamon-runtime && chown -R api:api /opt/api/metamon-runtime
USER api
ENV HOST=0.0.0.0 PORT=8787 RUNTIME_DIR=/opt/api/runtime
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=5s CMD node -e "fetch('http://127.0.0.1:8787/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "server.js"]
