# Sandbox runtime image: the isolation boundary for all agent code execution.
# Runs unprivileged, read-only root filesystem, no shell escalation. The compose file and the
# orchestrator add PID/memory/CPU limits and tmpfs workspace.
FROM oven/bun:1-alpine

RUN apk add --no-cache ca-certificates git ripgrep tini \
  && mkdir -p /workspace \
  && chown -R bun:bun /workspace

WORKDIR /workspace
COPY --chown=bun:bun health.ts entrypoint.ts ./

USER bun

ENV SANDBOX_HTTP_PORT=8788 \
    NODE_ENV=production

EXPOSE 8788

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["bun", "run", "./entrypoint.ts"]
