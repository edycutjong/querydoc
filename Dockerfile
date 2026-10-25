# Query Doctor — skeleton image (P22). Keyless: no credentials are baked in or required to build. Live mode needs the Zetaris
# JDBC jar and a JRE for the sidecar, mounted at run time (docs/DX-REPORT.md); the sample-mode server (port 8000) lands with the API.
FROM node:22-slim
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
ENV NODE_ENV=production
EXPOSE 8000
CMD ["npx", "tsx", "run.ts"]
