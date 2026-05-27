# IonBridgeWeb

小电拼 CP02 / CP02s 的独立前端监控面板。面板读取设备自带 Web Server 的 `/metrics.json`、`/porthistoryz`、`/heapz` 和首页 `window.__INFOZ`，提供实时功率、端口状态、历史曲线、任务负载、内存状态和产品外观主题预览。

## 启动

```bash
npm install
npm run dev
```

默认开发服务地址为 `http://localhost:5174/`。如果端口被占用，Vite 会提示实际端口。

生产构建：

```bash
npm run build
```

本地预览构建结果：

```bash
npm run preview
```

生产服务模式：

```bash
npm run build
npm run start
```

默认监听 `http://localhost:18318/`。

## Docker 部署

推荐用 Docker 部署，这样可以启用服务端目标配置、密码登录和更长时间的历史采集。

```bash
docker compose up -d --build
```

默认访问地址：

```text
http://localhost:18318/
```

`docker-compose.yml` 中常用环境变量：

```yaml
environment:
  IONBRIDGE_TARGET: "http://192.168.217.161"
  IONBRIDGE_REFRESH_MS: "30000"
  IONBRIDGE_RETENTION_DAYS: "30"
  IONBRIDGE_PASSWORD: "change-me"
volumes:
  - ./data:/data
```

- `IONBRIDGE_TARGET`: 初始设备地址，可以是 IP 或 mDNS 地址。
- `IONBRIDGE_REFRESH_MS`: 服务端采集 metrics 的默认频率，默认 30000ms。
- `IONBRIDGE_RETENTION_DAYS`: 服务端历史保留天数，默认 30 天。
- `IONBRIDGE_PASSWORD`: 设置后启用登录保护；不设置则不要求登录。
- `/data`: 持久化配置和历史数据。

容器内会保存：

```text
/data/config.json
/data/ionbridge.db
```

历史数据写入 SQLite，并按设备 SN/PSN 建索引查询。IP 或 mDNS 只作为连接目标保存，设备换 IP 后不会丢失同一台设备的历史。

## 设备地址

右上角输入框可以配置设备目标地址，例如：

```text
http://192.168.217.161
192.168.217.161
cp02s-1027249302340842.local
```

不带协议时会自动补成 `http://`。点击 `Apply` 后会重新获取设备信息、实时 metrics、heap 和历史数据。当前地址会保存到浏览器 `localStorage`。

开发模式下：

- 默认地址 `http://192.168.217.161` 走 Vite `/device` 代理。
- 其他地址走动态 `/device-proxy?target=...` 代理。

Docker/生产服务模式下，地址会同时保存到 `/data/config.json`，后台采集器也会切换到新目标。

## 刷新频率

地址右侧的数字输入框是 metrics 获取频率，单位为秒。默认是 `30s`，允许范围是 `1s` 到 `60s`。点击 `Apply` 后立即生效，并保存到 `localStorage`。

Docker/生产服务模式下，这个频率也会同步到服务端后台采集器。

如果请求失败，前端会对当前请求做多次递增间隔重试；本轮最终失败后会进入目标地址配置页，避免用 mock 数据误导用户。修改地址或点击重试后会继续尝试连接目标设备。

## 历史数据

设备的 `/porthistoryz` 通常提供电压和电流历史。前端会把实时 `/metrics.json` 采样补进本地 60 分钟滚动缓存，用于补足历史曲线和温度曲线。

浏览器 60 分钟历史缓存按设备目标地址隔离。生产服务的长期历史按设备 SN/PSN 归档，切换到同一台设备的新 IP/mDNS 后会继续查询同一份历史。

Docker/生产服务模式下，服务端会长期采集 `/metrics.json` 并写入 SQLite。每条样本包含：

- `ts`: 时间戳
- `target`: 设备地址
- `port`: 端口编号
- `voltage` / `current`
- `temperature_c`
- `power_w`
- `attached`
- `protocol`

历史查询接口：

```text
GET /api/history?target=http://192.168.217.161&hours=24
GET /api/history?target=http://192.168.217.161&hours=168&port=3
```

`hours` 支持 1 小时到 30 天。`port` 可选，用于筛选单个端口。

页面里的「长时间历史与筛选」会读取这个接口，支持：

- 1h / 6h / 24h / 7d / 30d 时间窗口。
- 全部端口或单端口筛选。
- 功率曲线和温度曲线同屏对比。
- 样本数、平均功率、峰值功率和最高温度统计。

长历史由服务端后台采集 `/metrics.json` 生成；开发模式下如果没有运行生产服务，这个面板会显示不可用，但实时图表仍使用设备 `/porthistoryz` 和浏览器 60 分钟缓存。

数据库文件为 `/data/ionbridge.db`。服务端会自动创建 `samples` 和 `devices` 表，并维护 `device_key + ts`、`device_key + port + ts` 索引。`device_key` 优先使用设备首页 `window.__INFOZ.psn`，取不到 SN 时才回退到目标地址。旧版本的 `/data/history/*.jsonl` 会在首次启动时导入一次，导入后继续保留原文件作为人工备份。

## 登录

设置 `IONBRIDGE_PASSWORD` 后，API、代理和历史接口会要求登录。登录会写入 HttpOnly Cookie；退出浏览器或重启服务后需要重新登录。

不设置 `IONBRIDGE_PASSWORD` 时面板无需登录，适合只在内网使用。

## 温度说明

当前数据结构里温度来自 `metrics.ports[].die_temperature`，也就是每个端口独立的 die temperature。页面顶部和 `Thermal peak` 显示所有端口中的最高温度。

因此，同一时刻不同端口温度不同是正常的。当前接口里没有单独的整机温度字段；如果固件后续暴露全局温度，可以在面板里单独接入。

## 外观主题

面板内置四个外观主题：

- CP02 Pro
- CP02 Ultra
- CP02s Pro
- CP02s Ultra

切换外观主题只影响产品视觉预览，不会写入设备。切换设备地址后，外观主题会回到设备信息推断出的默认主题。
