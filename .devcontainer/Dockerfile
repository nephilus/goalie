FROM docker.io/library/node:24.14.0-bookworm-slim@sha256:d8e448a56fc63242f70026718378bd4b00f8c82e78d20eefb199224a4d8e33d8
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl git python3 libssl3 libgssapi-krb5-2 libreadline8 liblz4-1 tzdata procps && rm -rf /var/lib/apt/lists/*
RUN npm install --global bun@1.4.2
RUN curl --fail --location --proto '=https' --tlsv1.2 https://github.com/vectorize-io/pg0/releases/download/v0.15.2/pg0-linux-x86_64-gnu -o /usr/local/bin/pg0 && echo '06c4678ff7b461dba8ed1f95c5e202ead3b57b70f549a22c17a94985121c0bf5  /usr/local/bin/pg0' | sha256sum -c - && chmod 755 /usr/local/bin/pg0
USER node
