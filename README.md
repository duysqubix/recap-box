# recap-box

A Claude Code mod: a small box beside the transcript that names the stage of the work and recaps the session in two or three sentences.

- The stage is one of researching, planning, coding, testing, debugging, reviewing, writing or shipping, each in its own theme color.
- Once a minute the box checks the transcript. It asks Haiku for a new recap only when the transcript changed and the box is on screen.
- A countdown under the recap shows the next check.

`/recap-box` opens the box again after you close it.

## Install

At the prompt of a terminal session:

```
/plugin install recap-box --marketplace duysqubix/recap-box
```

Answer `y` to add the marketplace, then press Enter for the user scope.

From a shell:

```
claude plugin install recap-box --marketplace duysqubix/recap-box
```

In the desktop app, where `/plugin` does not run: click + next to the prompt box, then Plugins, Add marketplace with `duysqubix/recap-box`, then Add plugin.

## Updates

Every commit on `main` is a release. `plugin.json` has no `version`, so Claude Code versions the plugin by commit.

Claude Code leaves auto-update off for marketplaces it does not ship. To turn it on, set `autoUpdate` on the marketplace's entry in `~/.claude/settings.json`. Claude Code ignores this flag in project and local settings.

```json
"extraKnownMarketplaces": {
  "recap-box": {
    "source": { "source": "github", "repo": "duysqubix/recap-box" },
    "autoUpdate": true
  }
}
```

That entry, with `"recap-box@recap-box": true` under `enabledPlugins`, has two effects:

- Each session checks for new commits at a random moment in its first 10 minutes. A session that takes one shows `Plugin updated: recap-box`, then reloads it or says to run `/reload-plugins`.
- The install heals itself. If the marketplace or the plugin record goes missing from `~/.claude/plugins`, it comes back within two session starts. Missing plugin files come back at the next check.

Claude Code skips the check when its own auto-updater is off, as under `DISABLE_AUTOUPDATER` or `DISABLE_UPDATES`. Set `FORCE_AUTOUPDATE_PLUGINS=1` to keep the check on for plugins.

To update right away:

```
claude plugin marketplace update recap-box && claude plugin update recap-box@recap-box
```

Then run `/reload-plugins` in any session that is already open.

## Develop

From your clone:

```
git config core.hooksPath .githooks   # once: turns on the pre-push checks
claude --plugin-dir .                 # this folder overrides the installed copy and reloads after each edit
```

A push to `main` is a release, so the pre-push hook blocks a push that fails these checks:

```
claude plugin validate . && claude plugin test . && tsc -p .
```

`tsc` needs the types the engine writes into `.claude-plugin/types/` the first time a `--plugin-dir` session loads the folder. Until then the hook skips it.
