# DeepSeek Inline Copilot

> VS Code 内联代码补全扩展 · 基于 DeepSeek V4 Flash · 可配置上下文与 Token 预算 · 实时错误检测
>
> Inline code completion for VS Code · Powered by DeepSeek V4 Flash · Configurable context & token budget · Real-time error checking

[📖 中文文档](README_CN.md)

## ✨ Features

- **Inline completions** — ghost text suggestions while you type
- **Real-time error checking** — detects bugs and suggests fixes with diagnostics
- **Smart context detection** — code files get full context (60+15 lines), text files get minimal (5+3 lines)
- **Token budget control** — configurable output tokens with cost estimates ($0.28/M output)
- **Dual trigger mode** — auto (while typing) or manual (Tab / Alt+/ only)
- **Cross-platform** — macOS, Windows, Linux

## 🚀 Quick Start

### 1. Get an API Key

→ [platform.deepseek.com](https://platform.deepseek.com/api_keys)

### 2. Install from .vsix

```bash
code --install-extension deepseek-inline-copilot-0.1.0.vsix
```

### 3. Configure

Click `✨ DeepSeek` in the status bar → opens Settings UI.

## ⚙️ Configuration

All settings accessible via Settings UI (`deepseek-inline-copilot`):

| Section | Key Settings |
| --- | --- |
| 🔑 API | apiKey, model (`deepseek-v4-flash`), baseUrl |
| ⚙️ Basic | enabled, triggerMode (`auto`/`manual`), triggerKey (`tab`/`alt+/`) |
| ⏱️ Timing | debounceMs (300), completionCooldownMs (7000) |
| 📝 Code Context | maxPrefixLines (60), maxSuffixLines (15) |
| 📄 Text Context | textMaxPrefixLines (5), textMaxSuffixLines (3) |
| 💰 Tokens | maxTokens (256), reviewMaxTokens (256) |
| 🔍 Errors | errorCheck, errorCheckMaxLines (10) |

### 💸 Cost (deepseek-v4-flash: $0.28/M output, $0.14/M input)

~$0.00021 per completion, ~$0.10/hour coding in auto mode.

## ⌨️ Keys & Commands

| Key | Action |
| --- | --- |
| `Tab` | Accept suggestion / trigger new one |
| `Alt+/` | Trigger suggestion (no-conflict mode) |

**Commands** (`Cmd/Ctrl+Shift+P`):

- Toggle Enable/Disable
- Trigger Inline Suggestion
- Review Document for Errors
- Clear All Errors
- Open Settings

## 🛠 Build & Package

```bash
npm install
npm run compile      # Compile TypeScript
npm run package      # Build .vsix file
```

Press **F5** to launch Extension Development Host.

## 📄 License

MIT
