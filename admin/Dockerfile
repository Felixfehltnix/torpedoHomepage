# Redaktions-Dienst: Node (ohne npm-Pakete) + git zum Committen der News
FROM node:22-alpine
RUN apk add --no-cache git
WORKDIR /site
EXPOSE 3000
CMD ["node", "/site/admin/server.mjs"]
