# Org Pulse — AI Engineering Backend
#
# Extends the core backend image with AI Eng-specific modules.

ARG CORE_TAG=latest
FROM quay.io/org-pulse/org-pulse-core-backend:${CORE_TAG}

USER 0

# Add AI Eng modules
COPY modules/ai-impact/ ./modules/ai-impact/
COPY modules/releases/ ./modules/releases/
COPY modules/upstream-pulse/ ./modules/upstream-pulse/
COPY modules/product-builds/ ./modules/product-builds/
COPY modules/system-health/ ./modules/system-health/

# Add AI Eng fixtures (for demo mode)
COPY fixtures/ai-impact/ ./fixtures/ai-impact/
COPY fixtures/releases/ ./fixtures/releases/
COPY fixtures/modules-state.json ./fixtures/modules-state.json

USER 65532
