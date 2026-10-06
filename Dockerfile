# 零 npm 依賴，所以沒有 install 這一步：映像裡只有 Node 本身加上 src/。
# 版本跟 CI 矩陣的最高版一致（目前的 Active LTS）。
FROM node:24-alpine

# ROUTER_HOST：容器裡綁 127.0.0.1 的話，埠發布進來的連線一個都收不到，所以綁全部介面；
# 對外只開在宿主的 127.0.0.1 由 compose.yaml 的 ports 負責。
# ROUTER_CONFIG：設定檔、traffic.log、HTTPS proxy 模式的 CA 都放在它旁邊，整包落在 /data 這個 volume。
ENV ROUTER_HOST=0.0.0.0 \
    ROUTER_CONFIG=/data/config.json

WORKDIR /app
# 只複製這三樣，.dockerignore 也是白名單：config.json 與 CA 私鑰絕不能被打包進映像
COPY package.json LICENSE ./
COPY src ./src

# 先建好 /data 並交給 node 使用者：具名 volume 第一次掛上時會沿用這個擁有者，非 root 也寫得進去
RUN mkdir /data && chown node:node /data
USER node
VOLUME /data

EXPOSE 8787 8788
# 直接跑 node（不經 npm）：SIGTERM 才會送到 src/index.mjs 自己的處理，docker stop 不必等逾時
CMD ["node", "src/index.mjs"]
