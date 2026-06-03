# IonBridgeWeb

小电拼 CP02 / CP02s 的独立前端监控面板。面板读取设备自带 Web Server 的 `/metrics.json`、`/porthistoryz`、`/heapz` 和首页 `window.__INFOZ`，提供实时功率、端口状态、历史曲线、任务负载、内存状态和产品外观主题预览。

界面内置中文和英文，语言选择会保存在浏览器本地。

## 界面预览

截图使用 CP02s 示例数据，仅作参考。

### 登录页

| 普通模式 | 深色模式 |
| --- | --- |
| ![登录页普通模式](./screenshots/login-light.png) | ![登录页深色模式](./screenshots/login-dark.png) |

### 监控总览

| 普通模式 | 深色模式 |
| --- | --- |
| ![监控总览普通模式](./screenshots/overview-light.png) | ![监控总览深色模式](./screenshots/overview-dark.png) |

### 端口数据与历史

| 普通模式 | 深色模式 |
| --- | --- |
| ![端口数据与历史普通模式](./screenshots/ports-light.png) | ![端口数据与历史深色模式](./screenshots/ports-dark.png) |

### 长时间历史与筛选

| 普通模式 | 深色模式 |
| --- | --- |
| ![长时间历史与筛选普通模式](./screenshots/history-light.png) | ![长时间历史与筛选深色模式](./screenshots/history-dark.png) |

### 移动端端口视图

| 普通模式 | 深色模式 |
| --- | --- |
| ![移动端端口视图普通模式](./screenshots/mobile-ports-light.png) | ![移动端端口视图深色模式](./screenshots/mobile-ports-dark.png) |

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

运行测试：

```bash
npm test
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

Compose 会同时启动一个 EMQX broker：

```text
MQTT:      mqtt://<宿主机局域网 IP>:1883
Dashboard: http://localhost:18083/
```

设备不能使用 `mqtt://127.0.0.1:1883`，也不能使用容器内部的 `mqtt://emqx:1883`。设备要连的是宿主机在局域网里的地址，例如 `mqtt://192.168.1.118:1883`。IonBridgeWeb 运行在容器内时也可以连接这个宿主机地址；它会把同一个地址通过 `/setbrokerz` 写入设备。

EMQX 管理后台默认用户是 `admin`，默认密码在 `docker-compose.yml` 里通过 `EMQX_DASHBOARD__DEFAULT_PASSWORD` 设置，部署前应修改。默认 MQTT 监听端口 `1883` 未配置客户端认证，适合内网测试；如果要映射到公网，必须在 EMQX 后台配置认证、ACL 或 TLS。

### EMQX 账号与访问控制

EMQX Dashboard 默认用户名是 `admin`。默认密码来自 `docker-compose.yml` 的 `EMQX_DASHBOARD__DEFAULT_PASSWORD`，第一次部署前建议先改成自己的密码。

Dashboard 的 `admin` 账号只用于登录 EMQX 管理后台，不等同于 MQTT 客户端账号。启用 Password-Based 客户端认证后，还需要在 EMQX 后台创建给设备和 IonBridgeWeb 使用的 MQTT 用户：

1. 打开 `http://localhost:18083/`，用 `admin` 和 `EMQX_DASHBOARD__DEFAULT_PASSWORD` 登录。
2. 进入「访问控制」→「客户端认证」。
3. 启用或新建 `Password-Based` 认证，数据源可以选择内置数据库。
4. 在「用户管理」里添加 MQTT 客户端用户，例如 `ocd`，并设置密码。
5. 回到 IonBridgeWeb 右上角设备设置，在「MQTT 接管」里填写 broker 地址、这个 MQTT 用户名和密码，再保存同步到设备。

设备和 IonBridgeWeb 必须使用同一组 MQTT 客户端账号。broker 地址要填设备能访问到的宿主机局域网地址，例如 `mqtt://192.168.1.118:1883`，不要填 `mqtt://127.0.0.1:1883` 或容器内地址 `mqtt://emqx:1883`。

`docker-compose.yml` 中常用环境变量：

```yaml
emqx:
  ports:
    - "1883:1883"
    - "18083:18083"
  environment:
    EMQX_DASHBOARD__DEFAULT_PASSWORD: "change-me"

environment:
  IONBRIDGE_RETENTION_DAYS: "30"
  IONBRIDGE_ALLOWED_TARGETS: "192.168.0.0/16,10.0.0.0/8,172.16.0.0/12,*.local"
  IONBRIDGE_ALLOW_TARGET_REDIRECTS: "false"
  IONBRIDGE_MAX_TARGET_REDIRECTS: "0"
  IONBRIDGE_SHOW_APPEARANCE_SWITCHER: "false"
  IONBRIDGE_PASSWORD: "change-me"
volumes:
  - ionbridge-data:/data

volumes:
  ionbridge-data:
  emqx-data:
  emqx-log:
```

- `IONBRIDGE_RETENTION_DAYS`: 服务端历史保留天数，默认 30 天。
- `IONBRIDGE_ALLOWED_TARGETS`: 允许访问的目标设备地址范围，支持 IPv4 CIDR、精确 host 和 `*.local` 通配，默认 `192.168.0.0/16,10.0.0.0/8,172.16.0.0/12,*.local`。
- `IONBRIDGE_ALLOW_TARGET_REDIRECTS`: 是否允许目标设备请求跟随 HTTP redirect，默认 `false`。
- `IONBRIDGE_MAX_TARGET_REDIRECTS`: 允许 redirect 时的最大跳转次数，默认 `0`，最大 `5`。
- `IONBRIDGE_SHOW_APPEARANCE_SWITCHER`: 是否显示外观主题调试切换器，默认 `false`。关闭时外观始终跟随设备识别结果。
- `IONBRIDGE_PASSWORD`: 设置后启用登录保护；不设置则不要求登录。
- `/data`: 持久化配置和历史数据。推荐使用 Docker named volume，避免非 root 容器用户写入宿主机 bind mount 时遇到 SQLite 只读错误。
- `emqx-data` / `emqx-log`: 持久化 EMQX 数据和日志。

建议在 Docker 或任何局域网可访问部署中设置 `IONBRIDGE_PASSWORD`。不设置密码时，任何能访问服务端口的设备都可以查看面板、切换设备和删除历史数据。

设备地址和采集频率不再通过环境变量配置。首次进入页面后，在设备设置里添加设备；服务端必须成功连接目标首页并解析到 `window.__INFOZ.psn` 后才会保存。拿不到 PSN 的地址不会写入 SQLite。

容器内会保存：

```text
/data/ionbridge.db
```

如果你改回 `./data:/data` 这种 bind mount，需要确保宿主机目录和数据库文件对容器运行用户可写。当前镜像使用非 root 用户运行，权限不对时会报 `attempt to write a readonly database`。迁移已有 bind mount 时可以先停容器，再执行类似命令修正权限：

```bash
docker compose down
sudo chown -R 1000:1000 ./data
docker compose up -d
```

历史数据写入 SQLite。PSN 是唯一设备标识；IP 或 mDNS 只作为当前连接地址保存，不会作为设备键。服务启动时会按当前 `IONBRIDGE_RETENTION_DAYS` 立即清理超出保留期的数据，之后后台也会周期清理。

## 设备地址

右上角齿轮按钮会展开设备设置，可以配置设备目标地址，例如：

```text
http://192.168.217.161
192.168.217.161
cp02s-1027249302340842.local
```

不带协议时会自动补成 `http://`。点击 `保存配置` 后，服务端会等待目标连接完成并读取 PSN。只有成功拿到 PSN 后，目标才会成为已保存设备；失败时按钮会恢复可点击，并显示错误。

开发模式下：

- 默认地址 `http://192.168.217.161` 走 Vite `/device` 代理。
- 其他地址走动态 `/device-proxy?target=...` 代理。

Docker/生产服务模式下，所有已保存设备都会被后台同时采集。页面顶部会显示已保存设备下拉列表，可以点击切换当前查看设备，也可以移除设备。移除设备会按 PSN 删除该设备和对应历史样本。

生产服务的 `/device-proxy` 只会代理 SQLite 中已经保存的设备。推荐使用 `device` 或 `psn` 参数按设备 PSN 解析当前地址；旧的 `target` 参数也必须完全匹配已保存设备地址，否则会返回 `403`，避免服务端被当成任意 HTTP 代理。

服务端访问目标设备前会执行目标地址校验。默认只允许 `http://` 下的 RFC1918 局域网地址和 `*.local`，并禁止自动跟随 redirect。需要特殊网段或固定 host 时，可以通过 `IONBRIDGE_ALLOWED_TARGETS` 增加规则。

已保存设备支持备注。备注只用于页面展示和识别设备，不参与设备唯一键；设备唯一键仍然只使用 PSN。

目标当前连不上但 SQLite 里已有历史样本时，页面仍会进入监控面板，实时状态显示为 `离线`，历史图表和长时间筛选继续可用。只有当前地址既连不上、又没有任何历史样本时，才会进入目标地址配置页。

## MQTT 接管

服务端支持连接 MQTT broker，用于接收固件实时遥测流和发送控制命令。右上角齿轮里的「MQTT 接管」可以配置：

- Broker 地址，例如 `mqtt://192.168.31.30:1883`、`mqtts://broker.example.com:8883`。
- MQTT 用户名和密码。
- 是否启用 MQTT。

启用后服务端会订阅：

```text
device/+/telemetry/+
device/+/enduser/response/+
```

对已经通过 HTTP 保存过、并且能用 PSN 匹配到的设备，服务端会把 MQTT 端口流写入 SQLite，并通过现有 `/api/live` SSE 推送到页面。端口卡片上的开关按钮会通过 MQTT 发送固件已有的 `TURN_ON_PORT` / `TURN_OFF_PORT` 命令；设备设置里也可以手动启动或停止遥测流。

「设备控制」折叠面板提供经过白名单校验的常用控制。控制 API 会等待固件 `CommandResponse` 返回，固件确认成功后前端才会显示完成；断线、超时或固件拒绝都会返回错误。

- 整机开关、重启。
- 启动/停止遥测流。
- 单端口开关。
- 充电策略、温控策略。充电策略按固件运行时枚举暴露：慢充、兼容快充、高性能、单口极速。
- 临时功率分配。
- TFCP / FCP / UFCS / SCP 兼容协议开关。
- 自定义 PDO 电压。
- 线补配置。
- 屏幕亮度和屏幕开关。由于 [ifanrx/IonBridge.git](https://github.com/ifanrx/IonBridge.git) 公开源码不是最新版本，CP02S 相关参数和屏幕控制代码不完整，屏显模式、旋转和待机动画暂时不能完整支持；IonBridgeWeb 会按当前可核对的固件能力置灰或说明不可用项。

以下固件命令没有放进普通 Web UI：license、OTA、清 NVS、原始 MCU forward、GPIO/ADC、工厂态切换。这些命令风险高或偏调试用途，不适合在日常监控面板里直接暴露。

保存 MQTT 配置时，服务端会先从设备首页的 `window.__CONFIG.broker` 读取当前 broker。只有当前值和 IonBridgeWeb 配置不一致时，才会调用设备 HTTP 接口写入：

```text
POST /setbrokerz
body: mqtt://host:1883
```

如果配置了 MQTT 用户名或密码，服务端会把它们写入 broker URI，例如 `mqtt://user:pass@host:1883`。点击「恢复默认」会对当前设备调用空 body 的 `POST /setbrokerz`，清除设备里的自定义 broker，并同步清空 IonBridgeWeb 本地 SQLite 中的 MQTT 配置。

如果 broker 暴露在局域网或公网，必须配置账号密码、ACL 或 TLS。设备接入自定义 broker 后，能向 `device/{psn}/enduser/request/+` 发布消息的一方就可以控制设备端口和配置。

## 刷新频率

设备设置里的数字输入框是当前设备的 metrics 获取频率，单位为秒。默认是 `30s`，允许范围是 `1s` 到 `60s`。目标连接成功并拿到 PSN 后立即生效。

Docker/生产服务模式下，这个频率会按 PSN 写入 `targets.refresh_interval_ms`，每台已保存设备可以有独立采集频率，并用于对应目标的服务端后台采集器。

生产服务会作为唯一采集器按这个频率请求设备，并通过 `/api/live` SSE 把最新 metrics、heap、Machine Info 和连接状态推送给已打开的页面。前端优先使用 SSE 增量更新实时面板；如果推送断开或长时间没有事件，会自动回退到原有 HTTP 拉取。

如果请求失败，前端会对当前请求做多次递增间隔重试；本轮最终失败后会进入目标地址配置页，避免用 mock 数据误导用户。修改地址或点击重试后会继续尝试连接目标设备。

运行状态接口：

```text
GET /api/status
```

这个接口返回当前 SSE client 数量、历史保留天数、每台已保存设备的 collector 状态、最近采样时间和 SQLite 样本数。设置了 `IONBRIDGE_PASSWORD` 时，这个接口同样需要登录。

## 历史数据

设备的 `/porthistoryz` 通常提供电压和电流历史。前端会把实时 `/metrics.json` 采样补进本地 60 分钟滚动缓存，用于补足历史曲线和温度曲线。

浏览器 60 分钟历史缓存按设备目标地址隔离。生产服务的长期历史按 PSN 归档。

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
GET /api/history?target=http://192.168.217.161&start=1779860000000&end=1779863600000
```

`hours` 支持 1 小时到 30 天。`start` / `end` 支持毫秒时间戳自定义范围。`port` 可选，用于筛选单个端口。

页面里的「长时间历史与筛选」会读取这个接口，支持：

- 1h / 6h / 24h / 7d / 30d 时间窗口。
- 自定义开始和结束时间。
- 全部端口或单端口筛选。
- 功率曲线和温度曲线同屏对比。
- 样本数、平均功率、峰值功率和最高温度统计。
- 跟随页面 metrics 刷新自动重拉当前筛选范围。

长历史由服务端后台采集 `/metrics.json` 生成；开发模式下如果没有运行生产服务，这个面板会显示不可用，但「实时功率与温度」仍使用设备 `/porthistoryz` 和浏览器 60 分钟滚动缓存。

数据库文件为 `/data/ionbridge.db`。服务端会自动创建 `targets`、`samples` 和 `settings` 表，并维护 `device_key + ts`、`device_key + port + ts` 索引。`targets.refresh_interval_ms` 按 PSN 保存每台设备的采集频率；`settings` 只保存当前选中的 `active_device_key` 这类全局状态。`device_key` 只使用设备首页 `window.__INFOZ.psn`，没有 PSN 的目标不会保存，也不会写入历史样本。

## 登录

设置 `IONBRIDGE_PASSWORD` 后，API、代理和历史接口会要求登录。登录会写入 HttpOnly Cookie，默认 7 天过期；服务重启后内存 session 会失效，需要重新登录。连续多次登录失败会触发短时间限速。

不设置 `IONBRIDGE_PASSWORD` 时面板无需登录，适合只在内网使用。

生产服务会返回基础安全响应头，包括 `X-Content-Type-Options`、`Referrer-Policy` 和限制同源资源的 CSP。Docker 镜像运行时使用非 root 用户。

## 温度说明

当前数据结构里温度来自 `metrics.ports[].die_temperature`，也就是每个端口独立的 die temperature。页面顶部和 `最高温度` 显示所有端口中的最高温度。

因此，同一时刻不同端口温度不同是正常的。当前接口里没有单独的整机温度字段；如果固件后续暴露全局温度，可以在面板里单独接入。

## 外观主题

面板内置四个外观主题：

- CP02 Pro
- CP02 Ultra
- CP02s Pro
- CP02s Ultra

默认情况下外观主题跟随设备信息自动识别，不允许手动修改。调试需要临时切换外观时，可以设置 `IONBRIDGE_SHOW_APPEARANCE_SWITCHER=true` 显示外观主题切换器。切换外观主题只影响产品视觉预览，不会写入设备；切换设备地址后，外观主题会回到设备信息推断出的默认主题。
