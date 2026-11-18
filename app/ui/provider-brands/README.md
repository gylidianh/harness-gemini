# Provider brand marks

These local assets replace the previous hand-drawn approximations. They identify
the configured provider; they do not imply endorsement or an official connection.
Custom/unknown providers keep their initial instead of borrowing another logo.

- Claude: SVG downloaded directly from https://claude.com/icon.svg.
- DeepSeek, OpenAI, Gemini, OpenRouter, Qwen and Kimi: brand SVGs distributed by
  [LobeHub Icons](https://github.com/lobehub/lobe-icons), pinned to revision
  `d044bd0413f3a7b8aa6dfd95a67be8240bf4cb0b`. This is a third-party icon collection,
  not a claim that each file was downloaded from the provider's official site.
- `manifest.json` records the source URLs, retrieval date and SHA256 of each file.
- `LICENSE-LobeHub.txt` contains the upstream MIT license. Brand names and marks
  remain the property of their respective owners; MIT does not grant trademark
  rights. Claude's asset is used only to identify that provider.

The source SVG files are unmodified. The generator strips standalone sizing,
the SVG title and the root inline style, and maps SVG attributes to React props.
It preserves all paths, view boxes, fills and gradients. No external requests,
HTML injection or runtime SVG parsing are used. Monochrome `currentColor` marks
inherit the theme's foreground; colored marks retain the source colors. Gradient
IDs are scoped to each rendered instance to avoid collisions between the header,
settings navigation and cards.

Regenerate the runtime data from the project root:

```powershell
python build-output/tools/generate-provider-icons.py
```
