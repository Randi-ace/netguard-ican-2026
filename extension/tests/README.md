# Extension v1.0.1 联调测试

在项目根目录运行：

```bash
node --test extension/tests/v1.0.1-integration.test.js
```

测试覆盖：

- 风险事件只使用 `score` 和 v1.0.1 请求字段；
- 广告拦截先按页面聚合，每页只上报一次，`blocked_count` 为本页实际合计；
- 风险/广告事件请求体只包含 v1.0.1 规定字段；
- `normal`、`strict`、`elder`、`child` 四种模式；
- 首次迁移时旧 `childSettings` 不会让儿童模式默认开启；
- 统一模式结构固定为 `adMode/elderMode/childMode/paused` 四个字段，重启后保留；
- 视频、登录、验证码和地图 iframe 不被广告规则误杀；
- `header`、`adapter`、`download` 以及普通 `/static/` 资源不会被宽泛规则误判；
- 暂停模式不产生风险或广告上传；
- `protectionPaused` 为最高优先级，赌博演示页不会调用风险接口或进入警告页；
- 风险请求期间切换暂停时，旧响应不会继续触发警告；
- Popup、内容脚本、兼容 API 和 warning 页面使用同一暂停状态；
- 网络失败和 HTTP 503 重试复用 UUID，`code=1` 作为终态成功；
- HTTP 400 不重试，HTTP 500 最多尝试 3 次后进入失败隔离区；
- API 基址由 `api-config.js` 统一管理，可通过 `netguardApiBaseUrl` 配置；
- 弹窗设置使用 `/api/settings` 的四字段请求体。
