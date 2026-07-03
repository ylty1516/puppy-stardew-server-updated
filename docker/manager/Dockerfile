FROM docker:27-cli

RUN apk add --no-cache nodejs docker-cli-compose

WORKDIR /app

COPY server.js /app/server.js

EXPOSE 18700

ENTRYPOINT ["node", "/app/server.js"]
