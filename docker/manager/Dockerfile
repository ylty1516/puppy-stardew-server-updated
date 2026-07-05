ARG MANAGER_BASE_IMAGE=docker:27-cli
FROM ${MANAGER_BASE_IMAGE}

RUN apk add --no-cache bash curl docker-cli-compose git nodejs rsync tar

WORKDIR /app

COPY server.js /app/server.js

EXPOSE 18700

ENTRYPOINT ["node", "/app/server.js"]
