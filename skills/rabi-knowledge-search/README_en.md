English | [简体中文](README.md)

# Install Rabi knowledge search

For project maintainers. This skill asks an Agent to search plans and memories before locating files when Rabi is online, and use ordinary search when it is offline. It requires no Manager changes or Hook installation.

The source files are `SKILL.md` and `agents/openai.yaml` in this directory. Copy the entire directory to `.agents/skills/rabi-knowledge-search/` in the target project and add this instruction to its `AGENTS.md`:

```markdown
- When finding information, past decisions, scheduled arrangements, or task leads, read `.agents/skills/rabi-knowledge-search/SKILL.md` first. If Rabi is online, search memories and plans before searching files as needed; otherwise use ordinary search.
```

Check the destination first. Create the directory for an initial installation; for upgrades, compare differences and preserve project changes before syncing the source files. Compare file hashes after copying and verify the `AGENTS.md` link. Updating the Rabi repository does not update existing project copies automatically; repeat the comparison and synchronization for upgrades. New tasks can load the project entry automatically; existing tasks must explicitly read the updated entry.

The task needs an existing relevant persona scope and a supported connection entry. The skill does not store machine addresses, credentials, or persona bindings. Follow the dynamic endpoint, bounded timeout, and offline fallback instructions in [SKILL.md](SKILL.md). Keep project-specific connection configuration in the project, separate from Rabi's generic skill.
