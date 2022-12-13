FROM node:14-alpine

RUN npm config set registry http://mirrors.cloud.tencent.com/npm/ && mkdir -p /usr/src/dmq-bot && cd /usr/src/dmq-bot && npm install && npm install -g pm2@latest && pm2 start /usr/src/dmq-bot/ecosystem.config.js && pm2 logs "/(danmaqua-bot|dmsrc-bilibili|dmsrc-douyu)/"

WORKDIR /usr/src/dmq-bot
