# China Weather Worker

定时抓取中国气象卫星云图并上传到 Google Drive。使用 Cloudflare Workers 定时触发，D1 记录已处理的时间戳，避免重复上传。

**实现逻辑**
1. 每 30 分钟触发一次定时任务（UTC）。
2. 请求气象卫星 JSONP 接口并解析出图片列表。
3. 以接口返回的时间字符串 `ft` 作为文件名。
4. 先查询 D1 是否已处理过该 `ft`。
5. 未处理则下载图片并上传到 Google Drive。
6. 上传成功后写入 D1，记录已处理。

**目录结构**
- `src/index.js` Worker 入口逻辑
- `wrangler.toml` Worker 配置与定时、D1 绑定
- `schema.sql` D1 表结构

**前置条件**
- Cloudflare Workers 账号
- Cloudflare D1 数据库
- Google Cloud Service Account（具备 Google Drive 写入权限）

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

4. 配置环境变量
- 在 `wrangler.toml` 填入以下变量
- `GDRIVE_CLIENT_EMAIL` Service Account 邮箱
- `GDRIVE_FOLDER_ID` 目标文件夹 ID

5. 设置私钥密文
```
wrangler secret put GDRIVE_PRIVATE_KEY
```

**如何获取 Google Drive 参数**
1. 创建 Service Account
- 打开 Google Cloud Console
- 选择或创建项目
- 进入 **IAM & Admin → Service Accounts**
- 点击 **Create Service Account**

2. 生成密钥（JSON）
- 在 Service Account 详情页打开 **Keys → Add key → Create new key**
- 选择 JSON 并下载
- JSON 中 `client_email` 对应 `GDRIVE_CLIENT_EMAIL`
- JSON 中 `private_key` 对应 `GDRIVE_PRIVATE_KEY`

3. 获取 Google Drive 文件夹 ID
- 在浏览器打开目标文件夹
- 地址栏 URL 中 `folders/` 后的字符串即为 ID

4. 授权 Service Account
- 在 Google Drive 中打开目标文件夹
- 点击 **共享**
- 添加 Service Account 邮箱并授予“编辑者”权限

**注意事项**
- 目标 Google Drive 文件夹必须共享给 Service Account 邮箱。
- Cron 使用 UTC 时区。当前配置为每 30 分钟执行一次。
- 如果需要修改频率，编辑 `wrangler.toml` 的 `triggers.crons`。

**部署**
```
wrangler deploy
```

**本地开发（可选）**
```
wrangler dev
```
