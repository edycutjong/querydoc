# Query Doctor — keyless image. Builds with no credentials and starts the API on :8000.
#   docker build -t querydoc .
#   docker run --rm -p 8000:8000 -e SAMPLE_MODE=true querydoc
#   curl -X POST localhost:8000/run -H 'Content-Type: application/json' -d @input_examples/example_1.json
# Sample mode (DuckDB on the committed NYC TLC subset) needs nothing else. Live mode needs the Zetaris JDBC jar and a JDK (javac +
# java; the sidecar is compiled from engine/zetaris-jdbc/QuerySidecar.java on first use, a JRE alone cannot do that — built on
# OpenJDK 17), mounted at run time (docs/DX-REPORT.md); `docker run --rm querydoc npm test` runs the keyless suite inside the image.
FROM node:22-slim
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
ENV PORT=8000
EXPOSE 8000
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s CMD node -e "fetch('http://127.0.0.1:8000/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["npm", "start"]
