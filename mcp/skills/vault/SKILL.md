---
name: vault
description: Search, read, write, and manage files in the Kept conversation vault. Use when the user asks about past conversations, wants to save notes, needs to find specific content, or wants to organize their vault.
---

# Kept Vault

You have access to the user's Kept vault — a local folder of markdown files capturing AI conversations from ChatGPT, Claude, and Gemini.

## Tools Available

- `list_vault` — Browse vault structure
- `list_directory` — Browse a specific folder
- `read_file` — Read a conversation or note
- `write_file` — Create a new file (fails if exists)
- `update_file` — Overwrite an existing file (fails if missing)
- `delete_file` — Remove a file
- `move_file` — Move or rename a file
- `grep_vault` — Regex search across all markdown files

## Workflow Rules

1. **Search before creating.** Always `grep_vault` or `list_vault` to check if content already exists before writing new files.
2. **Confirm destructive operations.** Before `delete_file` or `move_file`, tell the user what you're about to do and get confirmation.
3. **Cite sources.** When referencing content from vault files, cite by conversation title and file path.
4. **Respect structure.** Vault uses `provider/conversation-title.md` layout (e.g., `claude/my-chat.md`, `chatgpt/session.md`). Follow this when creating files.
5. **Use grep for content questions.** "Did we discuss X?" → `grep_vault`. "What's in this file?" → `read_file`. "What files exist?" → `list_vault`.
