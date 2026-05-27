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

## 设备地址

右上角输入框可以配置设备目标地址，例如：

```text
http://192.168.217.161
192.168.217.161
```

不带协议时会自动补成 `http://`。点击 `Apply` 后会重新获取设备信息、实时 metrics、heap 和历史数据。当前地址会保存到浏览器 `localStorage`。

开发模式下：

- 默认地址 `http://192.168.217.161` 走 Vite `/device` 代理。
- 其他地址走动态 `/device-proxy?target=...` 代理。

## 刷新频率

地址右侧的数字输入框是 metrics 获取频率，单位为秒。默认是 `30s`，允许范围是 `1s` 到 `60s`。点击 `Apply` 后立即生效，并保存到 `localStorage`。

如果请求失败，前端会对当前请求做多次递增间隔重试；本轮最终失败后会显示 mock 数据，并在下一轮刷新时继续尝试连接目标设备。

## 历史数据

设备的 `/porthistoryz` 通常提供电压和电流历史。前端会把实时 `/metrics.json` 采样补进本地 60 分钟滚动缓存，用于补足历史曲线和温度曲线。

历史缓存按设备目标地址隔离。切换设备地址后，不会混用上一台设备的端口历史。

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

