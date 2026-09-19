# Taste
- Prefers a design-first workflow: wants a written technical/architecture design document before any coding begins ("先不要急于编码... 从撰写设计方案开始"). Confidence: 0.9
- Prefers initializing the version control repo and creating a dedicated design/plan directory (e.g. `docs/design/`) as the first concrete step of a new project. Confidence: 0.7
- Does not want Python in the stack; prefers a non-Python implementation (chose a TypeScript-based stack) even when porting logic from an existing Python project. Confidence: 0.85
- Wants tools delivered as a web UI, not CLI-only. Confidence: 0.7
- Prefers a TypeScript full-stack monorepo (pnpm workspaces) with a shared types/contract package so types flow end-to-end between backend and frontend. Confidence: 0.75
- Prefers SQLite (single file, zero-ops) for personal-use persistence over JSON-file caches or a standalone DB server. Confidence: 0.6
- Builds software as an extensible "toolbox": a shared shell/framework plus independent pluggable tools, designed up-front so new tools can be added incrementally over time without touching framework code. Confidence: 0.75
- Expects the same app to run both locally during development and on a personal server long-term, and wants the design to cover both. Confidence: 0.55
- Builds personal, single-user tools (no multi-user/account system or auth requirement). Confidence: 0.6
