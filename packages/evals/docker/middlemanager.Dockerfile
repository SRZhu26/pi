FROM node:22-bookworm-slim

RUN apt-get update \
	&& apt-get install --no-install-recommends -y ca-certificates git bash \
	&& rm -rf /var/lib/apt/lists/*

WORKDIR /opt/pi
COPY . .
RUN npm ci --ignore-scripts

RUN mkdir -p packages/ai/src/providers/data \
	&& for shard in packages/ai/src/providers/*.models.ts; do \
		provider="$(basename "$shard" .models.ts)"; \
		printf '{"chat":{},"image":{},"classifier":{}}\n' > "packages/ai/src/providers/data/${provider}.json"; \
	done \
	&& printf '{}\n' > packages/ai/src/providers/data/.manifest.json

RUN cd packages/chord && npm run build \
	&& cd ../tui && npm run build \
	&& cd ../telemetry && npm run build \
	&& cd ../codemode && npm run build \
	&& cd ../mcp && npm run build \
	&& cd ../ai && npx tsc -p tsconfig.build.json && npx shx rm -rf dist/providers/data && npx shx cp -r src/providers/data dist/providers/data \
	&& cd ../durable && npm run build \
	&& cd ../env && npm run build \
	&& cd ../agent && npm run build \
	&& cd ../protocol && npm run build \
	&& cd ../client && npm run build \
	&& cd ../server && npm run build \
	&& cd ../coding-agent && npm run build

WORKDIR /work