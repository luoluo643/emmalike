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
