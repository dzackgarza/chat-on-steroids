FROM debian:bookworm-slim
RUN apt-get update \
 && apt-get install -y --no-install-recommends git python3 ripgrep ca-certificates \
 && rm -rf /var/lib/apt/lists/*
RUN find / -xdev -type f -perm /6000 -exec chmod a-s {} +
ENV PATH=/usr/bin:/bin HOME=/tmp
WORKDIR /work
CMD ["/bin/sh"]
