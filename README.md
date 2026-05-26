# DeepSeek Inline Copilot

Inline code completion for VS Code — powered by DeepSeek V4 Flash. Configurable context, token budget, and real-time error checking.

[中文文档](README_CN.md)

## Features

- **Inline completions** — ghost text suggestions appear as you type
- **Real-time error checking** — detects bugs and suggests fixes with diagnostic markers
- **Smart context detection** — code files get full context (60+15 lines), text files get minimal (5+3 lines)
- **Token budget control** — configurable output tokens with cost estimates ($0.28/M output)
- **Dual trigger mode** — auto (while typing) or manual (Tab / Alt+/ only)
- **Cross-platform** — macOS, Windows, Linux

## Getting Started

### 1. Get an API Key

Visit [platform.deepseek.com](https://platform.deepseek.com/api_keys) to create an API key.

### 2. Install

```bash
code --install-extension deepseek-inline-copilot-0.1.0.vsix
```

### 3. Configure

Click `DeepSeek` in the VS Code status bar to open the settings UI.

## Configuration

All settings are available under `deepseek-inline-copilot` in VS Code settings UI.

| Category | Key Settings |
| --- | --- |
| API | apiKey, model (`deepseek-v4-flash`), baseUrl |
| Basic | enabled, triggerMode (`auto`/`manual`), triggerKey (`tab`/`alt+/`) |
| Timing | debounceMs (300), completionCooldownMs (7000) |
| Code Context | maxPrefixLines (60), maxSuffixLines (15) |
| Text Context | textMaxPrefixLines (5), textMaxSuffixLines (3) |
| Tokens | maxTokens (256), reviewMaxTokens (256) |
| Errors | errorCheck, errorCheckMaxLines (10) |

### Pricing (deepseek-v4-flash)

- Output: $0.28/M tokens
- Input: $0.14/M tokens

~$0.00021 per completion, ~$0.10/hour during active coding in auto mode.

## Key Bindings

| Key | Action |
| --- | --- |
| `Tab` | Accept suggestion / trigger new one |
| `Alt+/` | Trigger suggestion (no-conflict mode) |

### Commands (Cmd/Ctrl+Shift+P)

- Toggle Enable/Disable
- Trigger Inline Suggestion
- Review Document for Errors
- Clear All Errors
- Open Settings

## Build

```bash
npm install
npm run compile      # Compile TypeScript
npm run package      # Build .vsix file
```

Press **F5** in VS Code to launch the Extension Development Host.

## License

MIT
