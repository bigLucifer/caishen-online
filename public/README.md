# 财神大战 · 联机对战版

3-6 人巫师牌变体，各自手机同步对战，微信群发链接即可邀请朋友。

## 本地跑

```bash
cd caishen-online
npm install
npm start
# 浏览器打开 http://localhost:8080
```

多开几个浏览器标签或者手机（同一 Wi-Fi 用局域网 IP）加入同一个房间即可对战。

## 部署到 Render.com（免费）

### 一次性配置

1. 打开 https://render.com 用 GitHub 账号登录（免费）
2. 把 `caishen-online` 目录推到你的 GitHub 一个 repo
3. Render Dashboard → **New** → **Web Service** → 连接你刚推的 repo
4. 填写：
   - **Name**：随意，例如 `caishen`
   - **Region**：Singapore（国内访问快）
   - **Branch**：main
   - **Runtime**：Node
   - **Build Command**：`npm install`
   - **Start Command**：`npm start`
   - **Instance Type**：Free
5. 点 **Create Web Service**，等 1-2 分钟部署完成
6. 得到一个公网地址例如 `https://caishen.onrender.com`

### 之后

- 修改代码 → `git push` → Render 自动重新部署（约 1-2 分钟）
- 免费实例 15 分钟无请求会休眠，首次唤醒需要 30 秒左右

## 目录

```
caishen-online/
├── server.js          # Node + ws 房间服务（权威规则）
├── package.json
├── public/
│   └── index.html     # 客户端（大厅+对战一体页）
└── README.md
```

## 玩法要点

- 房主建房 → 拿到 4 位房间码 → 发链接 `https://xxx.onrender.com/?r=XXXX` 到微信群
- 朋友点链接 → 输入昵称 → 自动加入房间
- 至少 3 人，房主点"开始"
- 押把公开可见，先出玩家一轮内固定，每把结算后回到轮首出者
- 断线 → 自动重连（保留座位）
