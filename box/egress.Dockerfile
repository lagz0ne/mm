# A project's egress proxy (plans/project-box.md, M1-B): the only way out of a box. tinyproxy with an allowlist of
# names (one anchored pattern per line, mounted read-only from $MM_HOME/egress/<project>/allow); IPv4 first, since the
# proxy's network may have no IPv6 route. Every connection is logged (stdout), with the project in the container name.
#   mm box build      (docker build -t mm-egress:<mm version> -f box/egress.Dockerfile box/)
FROM ubuntu:24.04@sha256:fe81560990fae86dc4743202b2cb4d3df98d0bcf949173cecef15ce1127ef852
ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update -qq && apt-get install -y -qq --no-install-recommends tinyproxy ca-certificates && rm -rf /var/lib/apt/lists/* \
 && echo 'precedence ::ffff:0:0/96 100' >>/etc/gai.conf \
 && printf '%s\n' 'User tinyproxy' 'Group tinyproxy' 'Port 8888' 'Listen 0.0.0.0' 'Timeout 120' 'LogLevel Connect' 'MaxClients 100' \
      'Allow 0.0.0.0/0' 'Filter "/etc/mm/allow"' 'FilterType ere' 'FilterDefaultDeny Yes' 'FilterURLs Off' 'ConnectPort 443' >/etc/tinyproxy/tinyproxy.conf
CMD ["tinyproxy", "-d", "-c", "/etc/tinyproxy/tinyproxy.conf"]
