# The project box's base image (plans/project-box.md, milestone 1 A). Every tool is pinned; what comes from a release
# is checked against a sha256 pinned here; npm tools come from the committed lockfile (box/npm). One user, `box` (uid = the host's owner of the project files, so the
# mounted project keeps its owner), no sudo. mm runs the box with a read-only root, cap-drop ALL, no-new-privileges.
#   mm box build      (docker build -t mm-box:<mm version> box/)
# the base by digest, not by tag (review sy-b15.15)
FROM ubuntu:24.04@sha256:fe81560990fae86dc4743202b2cb4d3df98d0bcf949173cecef15ce1127ef852

ARG UID=1000
# the box user's home = the host owner's home path, so the project mounted at its own path is inside that home
# (bd refuses a workspace under /home/ outside the current user's home, by the account database)
ARG HOME_DIR=/home/box
ARG NODE=24.21.0
ARG NODE_SHA256=fd8e59d5a511510f6a298afb548f18c7d2b1be404d8b4a27d94fbe49f56cb2d6
ARG PROCESS_COMPOSE=1.124.0
ARG PROCESS_COMPOSE_SHA256=487ce011d5324b4578d3ec1860aaa1dd3a95bd4b2b433e03791f73a23d215fd3
ARG BUN=1.4.4
ARG BUN_SHA256=bf8ccbfb2b0b80159e0f9a6d15c55317add8077534dbc6130a3edb52fccb395c

ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update -qq \
 && apt-get install -y -qq --no-install-recommends ca-certificates curl git jq tini bubblewrap socat xz-utils unzip less procps \
 && dpkg-query -W -f '${Package} ${Version}\n' >/etc/mm-box.packages && rm -rf /var/lib/apt/lists/*

# node (nodejs.org, sha256 pinned here)
RUN curl -fsSLo /tmp/node.tar.xz https://nodejs.org/dist/v${NODE}/node-v${NODE}-linux-x64.tar.xz \
 && echo "${NODE_SHA256}  /tmp/node.tar.xz" | sha256sum -c - \
 && tar -xJf /tmp/node.tar.xz -C /usr/local --strip-components=1 --exclude='*/CHANGELOG.md' --exclude='*/README.md' \
 && rm /tmp/node.tar.xz && node --version

# process-compose and bun (GitHub releases, sha256 pinned here: a checksum file from the same release proves only that
# the download is whole, not who made it)
RUN cd /tmp \
 && curl -fsSLO https://github.com/F1bonacc1/process-compose/releases/download/v${PROCESS_COMPOSE}/process-compose_linux_amd64.tar.gz \
 && echo "${PROCESS_COMPOSE_SHA256}  process-compose_linux_amd64.tar.gz" | sha256sum -c - \
 && tar -xzf process-compose_linux_amd64.tar.gz -C /usr/local/bin process-compose \
 && curl -fsSLO https://github.com/oven-sh/bun/releases/download/bun-v${BUN}/bun-linux-x64.zip \
 && echo "${BUN_SHA256}  bun-linux-x64.zip" | sha256sum -c - \
 && unzip -q bun-linux-x64.zip && mv bun-linux-x64/bun /usr/local/bin/bun \
 && rm -rf /tmp/* && process-compose version --short && bun --version

# Claude Code (unmodified, as Anthropic publishes it), Paseo and portless: `npm ci` from the committed lockfile, so every
# transitive package is the one recorded with its integrity hash (review sy-b15.15). No install script runs but Claude
# Code's own: it only links its native binary from the pinned optional package (no network)
COPY npm/package.json npm/package-lock.json /opt/mm-npm/
RUN cd /opt/mm-npm && npm ci --omit=dev --ignore-scripts --no-audit --no-fund \
 && node node_modules/@anthropic-ai/claude-code/install.cjs \
 && for b in claude paseo portless; do ln -s /opt/mm-npm/node_modules/.bin/$b /usr/local/bin/$b; done \
 && npm cache clean --force && claude --version && paseo --version && portless --version

RUN userdel -r ubuntu 2>/dev/null; mkdir -p "$(dirname ${HOME_DIR})" && useradd -u ${UID} -d ${HOME_DIR} -M -s /bin/bash box
# the box runs as its own uid (mm passes --user and its own passwd), so the project's repos are owned by another uid:
# git trusts them (every repo in a box is that project's), in the system config the box can't change
RUN git config --system --add safe.directory '*'
ENV HOME=${HOME_DIR}
USER box
WORKDIR /tmp
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["sleep", "infinity"]
