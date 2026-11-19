# Sandbox runtime image: the isolation boundary for all agent code execution.
#
# Build from the repository root so the runtime sources keep their package layout:
#   docker build -f infra/sandbox/Dockerfile -t freebuff/sandbox:local .
#
# The orchestrator adds PID/memory/CPU limits, a read-only root filesystem and no-new-privileges;
# the runtime inside adds the workspace jail, ulimits, output caps and the preview supervisor.
FROM oven/bun:1-alpine

RUN apk add --no-cache bash ca-certificates git ripgrep tini \
  && mkdir -p /workspace /opt/sandbox/runtime \
  && chown -R bun:bun /workspace /opt/sandbox

# Runtime code lives outside /workspace: the workspace is a tmpfs at run time, which would otherwise
# mask the entrypoint. /opt/sandbox stays on the read-only root filesystem.
COPY packages/sandbox-orchestrator/src/runtime /opt/sandbox/runtime/runtime
COPY packages/sandbox-orchestrator/src/workspace.ts \
     packages/sandbox-orchestrator/src/exec.ts \
     packages/sandbox-orchestrator/src/preview.ts \
     packages/sandbox-orchestrator/src/detect-preview.ts \
     packages/sandbox-orchestrator/src/errors.ts \
     /opt/sandbox/runtime/

RUN chown -R bun:bun /opt/sandbox/runtime

WORKDIR /workspace
USER bun

ENV SANDBOX_HTTP_PORT=8788 \
    SANDBOX_WORKSPACE=/workspace \
    SANDBOX_EGRESS_MODE=allowlist \
    NODE_ENV=production

EXPOSE 8788

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["bun", "run", "/opt/sandbox/runtime/runtime/entrypoint.ts"]
