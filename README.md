# China Weather Worker

定时抓取中国气象卫星云图并上传到 Google Drive。使用 Cloudflare Workers 定时触发，D1 记录已处理的时间戳，避免重复上传。

**实现逻辑**
1. 每 30 分钟触发一次定时任务（UTC）。
2. 请求气象卫星 JSONP 接口并解析出图片列表。
3. 以接口返回的时间字符串 `ft` 作为文件名。
4. 先查询 D1 是否已处理过该 `ft`。
5. 未处理则下载图片并上传到 Google Drive 的 `china_weather` 文件夹（不存在则自动创建）。
6. 上传成功后写入 D1，记录已处理。

**目录结构**
- `src/index.js` Worker 入口逻辑
- `wrangler.toml` Worker 配置与定时、D1 绑定
- `schema.sql` D1 表结构

**前置条件**
- Cloudflare Workers 账号
- Cloudflare D1 数据库
- Google 账号（通过 [Obsidian Google Drive](https://ogd.richardxiong.com) 获取 refresh token）

**配置步骤**
1. 安装 Wrangler 并登录
```
wrangler login
```

2. 创建 D1 数据库并替换 `wrangler.toml` 中的 `database_id`
```
wrangler d1 create china-weather
```

3. 初始化 D1 表
```
wrangler d1 execute china-weather --file=./schema.sql
```

4. 设置 Google Drive refresh token
```
wrangler secret put GDRIVE_REFRESH_TOKEN
```

**如何获取 Refresh Token**
1. 打开 https://ogd.richardxiong.com
2. 使用 Google 账号登录并授权
3. 页面会显示一个 refresh token，复制保存

**注意事项**
- 图片会自动上传到 Google Drive 根目录下的 `china_weather` 文件夹，首次运行时自动创建。
- Cron 使用 UTC 时区。当前配置为每 30 分钟执行一次。
- 如果需要修改频率，编辑 `wrangler.toml` 的 `triggers.crons`。

**部署**
```
wrangler deploy
```

**本地开发（可选）**

在项目根目录创建 `.dev.vars` 文件：
```
GDRIVE_REFRESH_TOKEN=你的refresh_token
```

初始化本地 D1 并启动：
```
wrangler d1 execute china-weather --local --file=./schema.sql
wrangler dev
```

手动触发定时任务：
```
curl http://localhost:8787/cdn-cgi/handler/scheduled
```
