# The mm fork of Doop as an image (sy-3yz): the pinned upstream image, with the server code of the fork in place of its
# own. Only server/ and shared/ change (box/doop/0001-gateway-assertion.patch); the client bundle (dist/) and
# node_modules are the base image's, unchanged. Context: the fork's source tree (upstream + the patch). build.sh makes
# it from the base image itself; from the published fork, the repository at its tag is the same tree.
#   docker build --build-arg BASE=<the pinned base image> -f box/doop/Dockerfile <the fork's source tree>
ARG BASE
FROM ${BASE}
COPY server /app/server
COPY shared /app/shared
LABEL org.opencontainers.image.title="doop (mm fork: one sign-in with the boards)" \
      mm.doop.patch="0001-gateway-assertion"
