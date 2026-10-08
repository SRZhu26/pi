FROM node:22-bookworm-slim

RUN apt-get update \
	&& apt-get install --no-install-recommends -y ca-certificates git bash \
	&& rm -rf /var/lib/apt/lists/*

WORKDIR /opt/pi
COPY . .
RUN npm ci --ignore-scripts \
	&& npm run build

WORKDIR /work