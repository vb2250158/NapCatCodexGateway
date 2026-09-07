English | [简体中文](README.md)

# Rabi DSH Context

Forwards session entry, user messages, tool callbacks, and turn completion to Rabi Manager. Manager owns persona context, switches, and decisions; this plugin stores no separate policy.

Click Update Hooks in Agent to install into the local DSH `web` profile, then reload the plugin or restart DSH. Each request discovers Manager through Host and verifies `/meta`. Source and test callers may supply a complete `RABI_MANAGER_URL`. Manager outages are reported without preventing standalone DSH use.

This event plugin can coexist with DSH messaging tools. Restrictions imposed by an older messaging plugin remain controlled by that plugin.
