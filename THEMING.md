# 轻酒馆主题指南

轻酒馆的所有基础样式都放在 CSS 层 `@layer tl-base` 里。你写的自定义 CSS 不在任何层里，所以**不需要 `!important`** 就能覆盖默认样式。

外观分三层，从简单到高级：

1. **阅读设置**（阅读页右上角 **Aa**）：选主题卡片（跟随系统、纸色、白色、护眼、羊皮、樱粉、夜间、墨蓝），调字号、字体、行距、段距、边距、首行缩进、两端对齐。改了马上生效，自动保存。
2. **自己的主题**（Aa 里的“自定义”卡片，或“我的 · 做一个自己的主题”）：像阅读器 App 的主题编辑器——
   - 背景：常用色一点即用，也可以自选颜色；可以上传背景图或从酒馆背景库里选，再调“图片变暗”“背景模糊”；
   - 颜色：文字、强调色、对白（引号里的话）、旁白（斜体）；文字和背景太接近时会提示并可一键调整；
   - 质感：卡片不透明度、毛玻璃、圆角；
   - 字体；
   - 效果：首字下沉、纸张纹理、对白加粗、我的话用斜体、显示角色名、去掉章首装饰，一点就开，再点就关；
   - **主题 CSS**：只在用这个主题时生效。上面的“效果”也会写进这里（带“开始 / 结束”注释），可以照着改。
   整页就是预览，改什么马上看得到；点“保存”才会保留，没保存就离开会先问你。
3. **自定义 CSS**（“我的 · 主题与外观 · 自定义 CSS”）：对所有主题都生效，优先级最高。

三层都同步到账号，换设备也一样。优先级：阅读设置 < 主题（含主题 CSS）< 自定义 CSS。

## 一、改变量（推荐）

大部分美化只需要改变量。这些变量是轻酒馆对外承诺的稳定接口，以后升级不会改名。

### 整体

| 变量 | 作用 | 默认（浅色） |
|---|---|---|
| `--tl-bg` | 页面底色（默认是暖白纸色） | `#f5efe3` |
| `--tl-bg-image` | 背景图，如 `url("…")`；`none` 表示不用 | `none` |
| `--tl-bg-size` | 背景图缩放方式（`cover`、`contain`、`auto`） | `cover` |
| `--tl-bg-blur` | 背景图模糊程度 | `0px` |
| `--tl-bg-dim` | 背景图上叠加的暗度，0 到 1 | `0` |
| `--tl-surface` | 卡片、输入框、按钮的底色，可以用半透明色 | `rgba(255,252,246,.92)` |
| `--tl-surface-blur` | 卡片和消息的毛玻璃模糊程度 | `0px` |
| `--tl-text` | 正文颜色 | `#2b2620` |
| `--tl-text-muted` | 次要文字颜色 | `#7a7064` |
| `--tl-accent` | 强调色（主按钮、名字、焦点框、你的消息左侧细线） | `#8b5e34` |
| `--tl-accent-text` | 强调色上的文字颜色 | `#ffffff` |
| `--tl-border` | 边框颜色 | `#e4dac8` |
| `--tl-header-bg` | 阅读页顶栏底色（半透明，下面有毛玻璃） | `rgba(245,239,227,.86)` |
| `--tl-header-height` | 阅读页顶栏高度 | `56px` |
| `--tl-danger` | 错误和停止按钮的颜色 | `#a63d32` |
| `--tl-radius` | 圆角大小 | `16px` |
| `--tl-shadow` | 卡片、输入框的阴影 | 柔和浅影 |

### 阅读排版

| 变量 | 作用 | 默认 |
|---|---|---|
| `--tl-font` | 字体 | 系统字体 |
| `--tl-font-size` | 字号 | `17px` |
| `--tl-line-height` | 消息正文行高 | `1.85` |
| `--tl-paragraph-gap` | 段落间距 | `0.7em` |
| `--tl-page-margin` | 正文左右边距 | `24px` |
| `--tl-text-indent` | 角色正文的首行缩进（`0` 为不缩进） | `2em` |
| `--tl-text-align` | 正文对齐方式（`justify` 两端对齐、`start` 左对齐） | `justify` |
| `--tl-chat-width` | 对话区最大宽度 | `720px` |

### 消息

| 变量 | 作用 |
|---|---|
| `--tl-bubble-user-bg` / `--tl-bubble-user-text` | 你的消息的底色和文字颜色（默认透明，左侧一条细线，像书页边的批注） |
| `--tl-bubble-char-bg` / `--tl-bubble-char-text` | 角色消息的底色和文字颜色（默认透明，像书的正文） |
| `--tl-name-color` | 消息上方名字的颜色 |
| `--tl-quote` | 引号内对白的颜色 |
| `--tl-em` | 斜体（动作、旁白）的颜色 |
| `--tl-strong` | 粗体的颜色 |
| `--tl-avatar-size` / `--tl-avatar-radius` | 头像大小和圆角 |

浅色和深色分别设置：

```css
:root { --tl-bg: #fbf7ee; }
@media (prefers-color-scheme: dark) {
    :root { --tl-bg: #1b1a17; }
}
```

## 二、改具体元素

需要更细的控制时，可以用下面这些类名和属性。它们同样是稳定接口。

| 选择器 | 对应元素 |
|---|---|
| `.tl-app[data-view="login\|library\|work\|me\|chat"]` | 整个应用，`data-view` 表示当前页面 |
| `.tl-login`、`.tl-library`、`.tl-chat` | 登录页、书架、阅读页的根元素 |
| `.tl-page`、`.tl-work`、`.tl-me` | 二级页面（作品详情、我的）的根元素 |
| `.tl-header` | 页面顶栏 |
| `.tl-card`、`.tl-character`、`.tl-continue` | 作品卡片、“继续”卡片 |
| `.tl-book`、`.tl-book-menu` | 书架上一本书（封面加 ⋯ 按钮）、它的 ⋯ 按钮 |
| `.tl-chips`、`.tl-chip[aria-pressed="true"]` | 书架的标签筛选条、选中的标签 |
| `.tl-work-hero`、`.tl-work-cover`、`.tl-work-intro` | 作品详情页的封面区、封面大图、简介 |
| `.tl-chapter-row[aria-current="true"]` | 作品详情页的一个章节，`aria-current` 表示上次读的章节 |
| `.tl-list`、`.tl-list-item` | “我的”页面和作品详情页的列表、列表里的一项 |
| `.tl-group`、`.tl-group-cover` | 合集（群聊）卡片、合集的拼图封面 |
| `.tl-messages` | 消息列表滚动区 |
| `.tl-message[data-role="user\|char\|system"]` | 一条消息，`data-role` 区分发送者 |
| `.tl-message-name`、`.tl-message-body` | 消息的名字行和正文 |
| `.tl-reader-header[data-hidden="true"]` | 阅读页顶栏；向下阅读时带 `data-hidden`，向上滑出 |
| `.tl-chapter` | 顶栏里的章节名 |
| `.tl-chapter-opening`、`.tl-chapter-kicker`、`.tl-chapter-heading`、`.tl-ornament` | 读到章节开头时显示的章首：小字章节名、大标题、装饰线 |
| `.tl-message-menu` | 消息右上角的 ⋯ 按钮 |
| `.tl-reply-tools` | 最后一条回复下方的工具行（换回复和继续写） |
| `.tl-swipe`、`.tl-swipe-button`、`.tl-swipe-count` | 换回复控件 |
| `.tl-continue-writing` | “继续写”按钮 |
| `.tl-composer`、`.tl-composer-box`、`.tl-composer-input`、`.tl-plus`、`.tl-send` | 底部输入区、悬浮输入框、输入框本身、“＋”按钮、发送按钮 |
| `.tl-ghost` | 顶栏里只有图标的按钮 |
| `.tl-message[data-role="char"] .tl-message-name > span` | 角色名（默认隐藏；用“显示角色名”效果或写 `display: inline` 打开） |
| `.tl-engine-status`、`.tl-engine-progress` | 完整版加载时输入区上方的状态条和进度线 |
| `.tl-sheet`、`.tl-sheet-item`、`.tl-sheet-item-hint` | 底部弹出面板、面板里的选项、选项的说明文字 |
| `.tl-continue-primary` | 书架顶部的“继续阅读”主卡 |
| `.tl-button`、`.tl-primary` | 按钮、主按钮 |
| `.tl-toast[data-level="error\|warning\|info"]` | 提示条 |
| `.tl-popup-bar` | 完整版有对话框等你处理时，底部出现的提示条 |

## 三、示例

### 纸质书阅读风

参考电子书阅读器的排版：暖色纸张、衬线字体、首行缩进，消息不加气泡。

```css
:root {
    --tl-bg: #f4ecd8;
    --tl-surface: transparent;
    --tl-text: #3b3226;
    --tl-text-muted: #8a7b66;
    --tl-accent: #8b5e34;
    --tl-border: #e2d6bd;
    --tl-font: "Songti SC", "Noto Serif SC", "Source Han Serif SC", serif;
    --tl-font-size: 18px;
    --tl-line-height: 1.9;
    --tl-paragraph-gap: 0.4em;
    --tl-chat-width: 680px;
    --tl-quote: #6b3f1d;
    --tl-em: #7a6a55;
}
.tl-message { border: 0; padding-inline: 4px; }
.tl-message[data-role="user"] { border-left: 3px solid var(--tl-accent); padding-left: 12px; }
.tl-message-body p { text-indent: 2em; }
```

### 背景图加毛玻璃

```css
:root {
    --tl-bg-image: url("https://你的酒馆地址/backgrounds/你的图片.jpg");
    --tl-bg-blur: 6px;
    --tl-bg-dim: 0.25;
    --tl-surface: rgba(255, 255, 255, 0.55);
    --tl-surface-blur: 12px;
}
```

背景图建议先上传到酒馆的背景库（原版“背景”面板），再用酒馆自己的地址引用。在手机上，同时开背景模糊和毛玻璃可能导致滚动不流畅；如果卡顿，先把 `--tl-surface-blur` 调成 `0px`。

### 夜间护眼

```css
:root {
    --tl-bg: #121212;
    --tl-surface: #1e1e1e;
    --tl-text: #c9c4b8;
    --tl-text-muted: #7d786e;
    --tl-accent: #c49a6c;
    --tl-accent-text: #121212;
    --tl-border: #2c2c2c;
    --tl-bubble-user-bg: #22201c;
    color-scheme: dark;
}
```

## 四、注意事项

- **分享主题**：主题编辑页的“分享这个主题”只导出这一个主题；“我的 · 主题与外观 · 导出主题”导出全部外观（阅读设置、自己的主题、自定义 CSS）。上传到你服务器的背景图会直接打包进文件，朋友导入时自动存进他自己的背景库。导入的主题总是新建一份，不会覆盖你已有的主题。
- **注意外部链接。** CSS 里的 `url(…)`、`@import` 会让浏览器去请求那个地址，对方服务器能看到访问者的 IP。导入的主题如果会从其他网站加载内容，轻酒馆会先提醒你确认。
- 消息正文的格式（斜体、引号、正则替换后的结构）由原版酒馆渲染，然后显示在轻酒馆里。角色卡自带的内联样式会保留，自定义 CSS 也能覆盖它们。
- 自定义 CSS 只作用于轻酒馆。点“完整版”看到的原版界面，仍然使用原版自己的主题设置。
- **样式写坏了怎么办：** 在轻酒馆地址的 `app/` 后面加上 `?safe` 打开（例如 `…/tavern-lite/app/?safe`），这次就不会套用已保存的 CSS。在“我的 · 主题与外观 · 自定义 CSS”里修正或清空后保存（主题 CSS 写坏了，就在 Aa 里换一个主题，再去编辑它），再去掉 `?safe` 重新打开。
