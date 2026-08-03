# Ocean and native Pi integration

This fork adds Ocean and Pi as first-class T3 Code providers. Ocean connects
through ACP. Pi runs directly inside the T3 server through the Pi coding-agent
SDK, without `pi-acp` or a separate subprocess. Each thread can select its own
model and thinking level, and existing native conversations can be imported.

## Requirements

- Ocean: a running `ocean-daemon` and the patched `ocean-acp` bridge from the
  Ocean stack. The defaults expect `ocean-acp` in `PATH` and the daemon at
  `http://127.0.0.1:4780`.
- Pi: credentials configured in the standard `~/.pi/agent` directory. The
  embedded runtime reuses Pi's credentials, models, settings, extensions,
  skills, prompt templates, and JSONL session store. Project-local Pi
  resources load only after that folder has been trusted in Pi; T3 never
  bypasses Pi's project trust decisions.

## Configure a provider

Open **Settings → Providers**, press **Add provider instance**, then select
Ocean or Pi.

Ocean settings:

- **Ocean ACP binary**: `ocean-acp` by default.
- **Ocean daemon URL**: `http://127.0.0.1:4780` by default.
- **Additional arguments**: optional arguments appended to the ACP bridge.

Pi has no launcher or bridge settings because it is embedded in T3. Its model
picker reflects the models currently available through the user's Pi model and
authentication configuration. New and imported Pi threads can choose `off`,
`minimal`, `low`, `medium`, `high`, `xhigh`, or `max` thinking when the selected
model supports that level.

## Import an existing session

When a folder is added as a project, T3 automatically discovers matching
Ocean/Pi sessions and restores them as threads if that project does not already
contain T3 threads. Re-adding an existing empty project triggers the same
recovery flow.

Automatic recovery keeps the native provider session as the source of truth
and projects its visible transcript into T3 once. Later session resumes filter
the provider replay, so restarting T3 does not duplicate imported messages.

For a manual import, open **Settings → Providers** and press the import button
next to **Add provider instance**.

1. Select the Ocean or Pi instance.
2. Select a native session returned by Ocean ACP or Pi's JSONL session store.
3. Confirm the T3 project, model, and thinking level.
4. Press **Import and resume**.

T3 stores the provider's native session ID and original working directory as a
resume binding. The next message loads that session in Ocean or Pi; the native
session remains the source of truth. Pi resumes the original JSONL file and
continues writing to the same session tree.

## Update this fork from upstream

The repository keeps `origin` pointed at the personal fork and `upstream`
pointed at `https://github.com/pingdotgg/t3code.git`.

Run:

```bash
scripts/update-from-upstream.sh
```

The updater:

1. refuses to run with uncommitted changes;
2. fetches `upstream/main`;
3. creates a timestamped `backup/…` branch;
4. merges upstream into the current fork branch;
5. installs the locked dependencies when dependency metadata changed;
6. runs the Ocean/Pi typechecks and focused tests.

If Git reports a conflict, the script aborts the merge and leaves the working
branch unchanged. Resolve a difficult upstream change on a separate branch
created from the reported safety branch.

Use `--skip-verify` only when you intentionally want to run validation later.
The updater never pushes automatically.
