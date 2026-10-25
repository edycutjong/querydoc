# Query Doctor — keyless image. Builds with no credentials and starts the API on :8000.
#   docker build -t querydoc .
#   docker run --rm -p 8000:8000 -e SAMPLE_MODE=true querydoc
#   curl -X POST localhost:8000/run -H 'Content-Type: application/json' -d @input_examples/example_1.json
# Sample mode (DuckDB on the committed NYC TLC subset) needs nothing else. The image carries no JDK and no JDBC driver: live mode runs
# with `npm start` on a machine that has the Zetaris JDBC jar and a JDK (javac compiles the sidecar on first use; a JRE alone cannot;
# runs here used OpenJDK 17.0.14 — docs/DX-REPORT.md "Running live"). `docker run --rm querydoc npm test` runs the keyless suite.
FROM node:22-slim
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
ENV PORT=8000
# inside the container the API must listen on every interface for -p to reach it (outside Docker it defaults to 127.0.0.1)
ENV HOST=0.0.0.0
EXPOSE 8000
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s CMD node -e "fetch('http://127.0.0.1:8000/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["npm", "start"]
