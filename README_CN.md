# DeepSeek Inline Copilot

基于 DeepSeek V4 Flash 的 VS Code 内联代码补全扩展。支持可配置上下文、Token 预算控制与实时错误检测。

[English Docs](README.md)

## 功能

- **内联补全** — 输入时自动弹出半透明建议
- **实时纠错** — 检测 bug 并用波浪线标记，显示修复建议
- **智能上下文** — 代码文件读取 60+15 行，纯文本只读 5+3 行
- **Token 预算控制** — 可设置输出上限并查看成本估算（输出 $0.28/M）
- **双触发模式** — 自动（打字触发）或手动（仅 Tab / Alt+/）
- **跨平台** — macOS、Windows、Linux

## 快速开始

### 1. 获取 API Key

前往 [platform.deepseek.com](https://platform.deepseek.com/api_keys) 创建 API 密钥。

### 2. 安装

```bash
code --install-extension deepseek-inline-copilot-0.1.0.vsix
```

### 3. 配置

点击 VS Code 状态栏中的 `DeepSeek` 图标，打开设置界面。

## 配置项

所有设置可在 VS Code 设置 UI 中搜索 `deepseek-inline-copilot` 进行修改。

| 分类 | 关键设置 |
| --- | --- |
| API | apiKey（密钥）、model（默认 deepseek-v4-flash）、baseUrl |
| 基础 | enabled（开关）、triggerMode（auto/manual）、triggerKey（tab/alt+/） |
| 节奏 | debounceMs（300ms 输入延迟）、completionCooldownMs（7000ms 补全间隔） |
| 代码上下文 | maxPrefixLines（光标前 60 行）、maxSuffixLines（光标后 15 行） |
| 文本上下文 | textMaxPrefixLines（光标前 5 行）、textMaxSuffixLines（光标后 3 行） |
| Token | maxTokens（补全 256）、reviewMaxTokens（纠错 256） |
| 纠错 | errorCheck（开关）、errorCheckMaxLines（检查 10 行） |

### 价格（deepseek-v4-flash）

- 输出：$0.28/M tokens
- 输入：$0.14/M tokens

每次补全约 $0.00021，连续编码约 $0.10/小时（自动模式）。

## 按键绑定

| 按键 | 功能 |
| --- | --- |
| `Tab` | 接受建议 / 触发新建议 |
| `Alt+/` | 触发建议（无冲突模式） |

### 命令（Cmd/Ctrl+Shift+P）

- Toggle Enable/Disable（开关）
- Trigger Inline Suggestion（触发建议）
- Review Document for Errors（审查错误）
- Clear All Errors（清除错误）
- Open Settings（打开设置）

## 构建

```bash
npm install
npm run compile      # 编译 TypeScript
npm run package      # 生成 .vsix 文件
```

在 VS Code 中按 **F5** 启动扩展开发调试。

## 协议

MIT
