# The project box's base image (plans/project-box.md, milestone 1 A). Every tool is pinned; what comes from a release
# is checked against that release's checksums. One user, `box` (uid = the host's owner of the project files, so the
# mounted project keeps its owner), no sudo. mm runs the box with a read-only root, cap-drop ALL, no-new-privileges.
#   mm box build      (docker build -t mm-box:<mm version> box/)
FROM ubuntu:24.04

ARG UID=1000
# the box user's home = the host owner's home path, so the project mounted at its own path is inside that home
# (bd refuses a workspace under /home/ outside the current user's home, by the account database)
ARG HOME_DIR=/home/box
ARG NODE=24.21.0
ARG NODE_SHA256=fd8e59d5a511510f6a298afb548f18c7d2b1be404d8b4a27d94fbe49f56cb2d6
ARG PROCESS_COMPOSE=1.124.0
ARG BUN=1.4.4
ARG CLAUDE_CODE=2.1.318
ARG PASEO=0.13.0
ARG PORTLESS=0.15.13

ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update -qq \
 && apt-get install -y -qq --no-install-recommends ca-certificates curl git jq tini bubblewrap socat xz-utils unzip less procps \
 && rm -rf /var/lib/apt/lists/*

# node (nodejs.org, sha256 pinned here)
RUN curl -fsSLo /tmp/node.tar.xz https://nodejs.org/dist/v${NODE}/node-v${NODE}-linux-x64.tar.xz \
 && echo "${NODE_SHA256}  /tmp/node.tar.xz" | sha256sum -c - \
 && tar -xJf /tmp/node.tar.xz -C /usr/local --strip-components=1 --exclude='*/CHANGELOG.md' --exclude='*/README.md' \
 && rm /tmp/node.tar.xz && node --version

# process-compose and bun (GitHub releases, checked against each release's own checksum file)
RUN cd /tmp \
 && curl -fsSLO https://github.com/F1bonacc1/process-compose/releases/download/v${PROCESS_COMPOSE}/process-compose_linux_amd64.tar.gz \
 && curl -fsSLO https://github.com/F1bonacc1/process-compose/releases/download/v${PROCESS_COMPOSE}/process-compose_checksums.txt \
 && grep ' process-compose_linux_amd64.tar.gz$' process-compose_checksums.txt | sha256sum -c - \
 && tar -xzf process-compose_linux_amd64.tar.gz -C /usr/local/bin process-compose \
 && curl -fsSLO https://github.com/oven-sh/bun/releases/download/bun-v${BUN}/bun-linux-x64.zip \
 && curl -fsSLO https://github.com/oven-sh/bun/releases/download/bun-v${BUN}/SHASUMS256.txt \
 && grep ' bun-linux-x64.zip$' SHASUMS256.txt | sha256sum -c - \
 && unzip -q bun-linux-x64.zip && mv bun-linux-x64/bun /usr/local/bin/bun \
 && rm -rf /tmp/* && process-compose version --short && bun --version

# Claude Code (unmodified, as Anthropic publishes it), Paseo and portless: exact versions from npm
RUN npm install -g --no-audit --no-fund @anthropic-ai/claude-code@${CLAUDE_CODE} @getpaseo/cli@${PASEO} portless@${PORTLESS} \
 && npm cache clean --force && claude --version && paseo --version && portless --version

RUN userdel -r ubuntu 2>/dev/null; mkdir -p "$(dirname ${HOME_DIR})" && useradd -u ${UID} -d ${HOME_DIR} -M -s /bin/bash box
ENV HOME=${HOME_DIR}
USER box
WORKDIR /tmp
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["sleep", "infinity"]
