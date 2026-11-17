# Sandbox runtime image: the isolation boundary for all agent code execution.
# Runs unprivileged, read-only root filesystem, no shell escalation. The compose file and the
# orchestrator add PID/memory/CPU limits and tmpfs workspace.
FROM oven/bun:1-alpine

RUN apk add --no-cache ca-certificates git ripgrep tini \
  && mkdir -p /workspace /opt/sandbox/runtime \
  && chown -R bun:bun /workspace /opt/sandbox

# Runtime code lives outside /workspace: the workspace is mounted as a tmpfs at run time, which
# would otherwise mask the entrypoint. /opt/sandbox stays on the read-only root filesystem.
COPY --chown=bun:bun health.ts entrypoint.ts /opt/sandbox/runtime/

WORKDIR /workspace
USER bun

ENV SANDBOX_HTTP_PORT=8788 \
    NODE_ENV=production

EXPOSE 8788

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["bun", "run", "/opt/sandbox/runtime/entrypoint.ts"]
