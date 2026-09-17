# Pi Agent WebUI — runs the pi coding agent in RPC mode and serves the browser UI.
FROM node:22-bookworm-slim

# git is useful for the agent's repo tools; ca-certs for API calls
RUN apt-get update \
 && apt-get install -y --no-install-recommends git ca-certificates curl \
 && rm -rf /var/lib/apt/lists/*

# Install the pi coding agent globally
RUN npm install -g @mariozechner/pi-coding-agent@latest

WORKDIR /app
COPY bridge/package.json /app/bridge/package.json
RUN cd /app/bridge && npm install --omit=dev
COPY bridge /app/bridge
COPY web /app/web

ENV PORT=3000 \
    WORKSPACE_DIR=/workspace \
    PI_SESSION_DIR=/root/.pi/agent/sessions \
    PI_COMMAND="pi --mode rpc"

EXPOSE 3000
WORKDIR /workspace
CMD ["node", "/app/bridge/server.js"]
