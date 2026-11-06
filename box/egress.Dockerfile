# A project's egress proxy (plans/project-box.md, M1-B): the only way out of a box. mm-egress (box/egress/main.go, Go's
# standard library only): HTTP CONNECT to port 443 only, for a name on the allowlist only (one anchored pattern per
# line, mounted read-only from $MM_HOME/egress/<project>/allow), and only to a public address: it resolves the name
# itself, refuses loopback, private, CGNAT, link-local and metadata, ULA, multicast and the docker networks, then
# connects to the address it checked (no second lookup: a later DNS change can't move it; sy-59m8). Every decision
# is one line on stdout, which mm appends to the project's egress log.
#   mm box build      (docker build -t mm-egress:<mm version> -f box/egress.Dockerfile box/)
# Both images are pinned by digest; the proxy is built here from mm's own source, its tests run first, offline.
FROM golang:1.27.3-bookworm@sha256:dc0963f32053e4bc451d24d87e3892d42d01021b61f093e98eb95c0352bb84b0 AS build
ENV CGO_ENABLED=0 GOPROXY=off GOFLAGS=-trimpath GOTOOLCHAIN=local
WORKDIR /src
COPY egress/ ./
RUN go vet ./... && go test -count=1 ./... && go build -ldflags='-s -w' -o /out/mm-egress . && sha256sum /out/mm-egress

FROM ubuntu:24.04@sha256:fe81560990fae86dc4743202b2cb4d3df98d0bcf949173cecef15ce1127ef852
ENV DEBIAN_FRONTEND=noninteractive
# socat: forwards the box's port 4000 to its own socket of mm's AI gateway (src/ai.ts), mounted at /run/mm/ai.
# The proxy runs as its own user (egress: no home, no shell); setpriv (util-linux) drops to it.
RUN apt-get update -qq && apt-get install -y -qq --no-install-recommends socat && rm -rf /var/lib/apt/lists/* \
 && useradd --system --no-create-home --home-dir /nonexistent --shell /usr/sbin/nologin egress
COPY --from=build /out/mm-egress /usr/local/bin/mm-egress
CMD ["setpriv", "--reuid=egress", "--regid=egress", "--clear-groups", "/usr/local/bin/mm-egress"]
