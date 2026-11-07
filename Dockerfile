# The hosted demo: the buyer page, the journey controls and the gateway on one port.
#
# With no configuration it runs on stand-in chains and needs no keys. Set SHOWCASE_MODE=live and
# the variables in .env.example to run on the testnets. Keys go in the host's secret store, never
# in this image: .dockerignore keeps .env out of it.
FROM node:22-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates curl \
  && rm -rf /var/lib/apt/lists/*

# anvil runs the stand-in chains. The same version the project was tested with.
ENV FOUNDRY_VERSION=1.5.0
RUN curl -fsSL "https://github.com/foundry-rs/foundry/releases/download/v${FOUNDRY_VERSION}/foundry_v${FOUNDRY_VERSION}_linux_$(dpkg --print-architecture).tar.gz" \
  | tar -xz -C /usr/local/bin anvil

RUN npm install -g pnpm@11.9.0

WORKDIR /app
COPY . .
RUN pnpm install --frozen-lockfile
RUN pnpm --filter @pinky/web build

ENV PORT=8080
EXPOSE 8080
CMD ["pnpm", "showcase"]
