# 回归测试

在一个**原版** SillyTavern 上验证轻酒馆。模型接口用本目录的模拟服务（`mock-llm.mjs`）代替，不需要真实的模型服务。GitHub Actions 对酒馆 1.16.0～1.19.0 各跑一遍（见 `.github/workflows/e2e.yml`）。

这些测试会新建角色、世界书、预设和聊天文件，**只能对专门准备的测试酒馆运行，不要指向自己平时用的酒馆。**

## 单元测试

```
npm run test:unit
```

不需要服务器。覆盖桥接排队与取消、故事作用域、番外流程、世界书与预设编辑器的合并和保存结果判断、草稿与存储故障、分享与目录等纯逻辑。

## 本机运行

需要 Docker 和 Node 22。

```
npm ci
npx playwright-core install --only-shell chromium
npm run test:prepare     # 准备原版酒馆 + 模拟模型 + 以“为所有用户安装”方式装入本扩展
npm test                 # 依次运行主流程与各阶段验收
```

`test:prepare` 会清空并重建本目录下的 `config/`、`data/`、`plugins/`、`extensions/`，扩展装在 `extensions/emmalike`。可用环境变量换版本或端口：

| 变量 | 默认值 | 作用 |
|---|---|---|
| `ST_IMAGE` | `ghcr.io/sillytavern/sillytavern:1.19.0` | 被测的酒馆镜像 |
| `ST_PORT` / `MOCK_PORT` | `8031` / `5001` | 本机端口；改端口时测试需配合设置 `ST_URL`、`MOCK_URL` |
| `COMPOSE_PROJECT_NAME` | 目录名 | 与本机其他测试环境并存时使用 |
| `TAVERN_HELPER_REF` | `4.11.2` | 同时装上的酒馆助手版本，留空则不装 |
| `INSTALL_PANEL_FIXTURE` | `1` | 装一个模仿状态栏扩展的测试扩展 |
| `INSTALL_SAVE_PLUGIN` | `0` | 装上可选的保存插件（`server-chat-save/`） |
| `CHROME_PATH` / `PLAYWRIGHT_CORE` | 自动 | 指定浏览器可执行文件或 playwright-core 路径 |

## 主要测试

- `e2e.mjs`：主流程。登录、书架、排队发送、流式回复、重新生成、切到原版界面、二次打开、按原版格式保存、自定义 CSS。后两个参数是模拟的网络延迟（毫秒）和下行带宽（Kbps）。
- `e2e-m0.mjs`～`e2e-m11.mjs`：各阶段的验收（阅读器、书架与管理、角色和消息编辑、前端卡片与扩展面板、开始使用、世界书与预设编辑等），每个文件开头的注释写着它测什么。
- `e2e-onboarding.mjs`：新建账号，验证原版的欢迎引导会切到前台，处理完后自动回到轻酒馆。
- `e2e-personal.mjs <地址> device`：摘录与备注只存在本机、按账号隔离，切换账号时不会串到别的账号。
- 其余 `e2e-*.mjs` 各测一项功能（番外、分支、保存与断网补存、换回复、停止、分享、目录、删除等），文件第一行注释写着用法。

## 隔离运行器

`tests/run-isolated.sh` 为一次测试起一个只装了本扩展的官方酒馆（每次用自己的项目名和端口，可以同时跑几组），再按测试各自要的参数逐个运行，每个最多跑 `TIMEOUT` 秒（默认 900）：

```sh
PROJECT=tlmine ST_PORT=8095 MOCK_PORT=5065 bash tests/run-isolated.sh e2e e2e-m1
PROJECT=tlmine ST_PORT=8095 MOCK_PORT=5065 bash tests/run-isolated.sh down
```

写死 8031/8032/8035 的测试会自动改成这次的端口再跑。`TAVERN_HELPER_REF=4.11.2 INSTALL_PANEL_FIXTURE=1` 装酒馆助手和测试扩展（e2e-m5、e2e-m6 需要）。日志在 `LOG_DIR`（默认 `/tmp/<项目名>`）。注意：`run-isolated.sh` 装进去的是已经构建好的 `app/`，改了 `src/` 要先 `npm run build`。

## 截图工具

`tests/tools/screens.mjs` 按手机尺寸截关键界面图，可选 `light` 或 `dark`；`tests/tools/make-icons.mjs` 生成应用图标。参数见各文件第一行的注释。

## 删除角色的非 JSON 响应回归

`npm run test:unit` 包含 `delete-character.test.mjs`：删除接口成功时不解析正文，覆盖 200 OK、204、401/403、HTTP 失败、网络失败以及其他 JSON 接口的解析行为。`TL_API_MODULE` 可指向基准副本的 `src/api.js`，验证旧代码能复现模拟的 Safari DOMException；这不是 iPhone 真机验证。

`PROJECT=tldelfixcodex ST_PORT=8098 MOCK_PORT=5068 bash tests/run-isolated.sh e2e-delete-character e2e-busy-feedback` 验证原版引擎未就绪时的删除、失败后重试、确认框关闭和书架刷新。专项只允许独立的 `127.0.0.1:8098`，只创建/删除自己的合成角色。运行前先构建，并确认端口未占用。结束后用相同变量运行 `tests/run-isolated.sh down`。

## 正则草稿的即时保留

node tests/e2e-ui-regex-drafts.mjs 使用真实 Preact 编辑器和合成桥接，检查输入后立即卸载、预设切换后继续输入的归属、保存期间继续输入、失败保留、明确放弃、账号隔离和新建目标恢复。只允许测试页面自己的回环请求，不连接酒馆或模型。支持 CHROME_PATH 和 TEST_OUTPUT。

PROJECT=tlregexdraft ST_PORT=8103 MOCK_PORT=5073 ST_IMAGE=ghcr.io/sillytavern/sillytavern:1.16.0 bash tests/run-isolated.sh e2e-regex-sim e2e-regex 对真实隔离酒馆验证预设切换、390×844 触摸视口、800ms 延迟、40KiB/s 下行、20KiB/s 上行及断网重试。模拟专项仅允许 127.0.0.1:8103。另在 1.19.0 上串行重复；运行前构建、检查端口，结束后同样的 PROJECT/ST_PORT/MOCK_PORT 运行 down。

隔离运行器准备失败立即停止；任一套件失败，运行器最终退出码为 1，即使后续套件通过也不会覆盖失败。npm run test:unit 包含不启动 Docker 的退出码回归测试。包装脚本仍需保留运行器退出码，不能只看 RUN-DONE。

## TT 酒馆（TauriTavern）冒烟测试

`tests/tt-smoke.mjs` 在安卓设备或模拟器上的 TT 酒馆里跑，查浏览器测试覆盖不到的部分：TT 只给自己页面和直接挂在上面的框架转请求、扩展在原版就绪后才加载、返回键由 TT 交给页面。单测里的 `tests/tt-host.test.mjs`、`native-bootstrap`（晚到路径）、`episode-native`、`world-editor-native-binding` 各有 TT 用例。

1. 把工作副本（`index.js`、`manifest.json`、`style.css`、`bridge*.js`、`src/`、`app/`）放进 TT 数据目录的 `default-user/extensions/<文件夹>`，在 TT 里重载。
2. `adb forward tcp:9258 localabstract:$(adb shell cat /proc/net/unix | grep -o 'webview_devtools_remote_[0-9]*' | head -1)`
3. `node tests/tt-smoke.mjs http://127.0.0.1:9258`；加 `--generate` 时还会发送、生成新回复和删除，需要 TT 连着模型：本机跑 `node tests/mock-llm.mjs`，TT 的自定义地址填 `http://10.0.2.2:5001/v1`（模拟器访问电脑用这个地址，`adb reverse` 的 127.0.0.1 TT 连不上），TT 第一次会弹框问要不要信任这个地址。带 `--generate` 的那组还查轻酒馆隐藏期间的事（回复写完、在原版里开始生成、切故事、浮层增删）、浮层相交时的实际点击、刷新时隐藏不抢 TT 输入框焦点、安装或更新后重载 TT 主页面并自动打开；最后一项会重载 TT。
