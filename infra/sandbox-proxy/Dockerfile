# Egress allowlist proxy. Builds from the repository root:
#   docker build -f infra/sandbox-proxy/Dockerfile -t freebuff/sandbox-proxy:local .
FROM oven/bun:1-alpine

RUN mkdir -p /opt/proxy/infra/sandbox-proxy /opt/proxy/packages/sandbox-orchestrator/src

# `egress.ts` imports only types from @freebuff/shared, which Bun erases, so no node_modules is
# needed in the image.
COPY infra/sandbox-proxy/proxy.ts infra/sandbox-proxy/entrypoint.ts /opt/proxy/infra/sandbox-proxy/
COPY packages/sandbox-orchestrator/src/egress.ts /opt/proxy/packages/sandbox-orchestrator/src/

WORKDIR /opt/proxy/infra/sandbox-proxy

ENV EGRESS_PROXY_PORT=8888
EXPOSE 8888

CMD ["bun", "run", "/opt/proxy/infra/sandbox-proxy/entrypoint.ts"]
