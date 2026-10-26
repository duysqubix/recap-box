# recap-box

A Claude Code mod: a small box beside the transcript that says, in plain words, what the session is doing now and what it is working toward.

- On top: the stage of the work and one or two sentences on what is happening now. The stage is one of researching, planning, coding, testing, debugging, reviewing, writing or shipping, each in its own theme color.
- The stage comes from the tools the session runs, not from a guess. It is the newest of the last five calls that does more than look. Edits are coding, or writing when they change docs. Test runs are testing, review agents are reviewing, and commits, pushes and CI watches are shipping. A shell command counts by the commands it starts, so `grep -rn test` is a look and `npm test` a test run.
- When the last five calls only read, search or run other commands, the stage is what a helper agent at work does, or researching. While the session waits on a helper agent, the stage is the helper's. When the newest test run among the last five failed, by its exit code or by a failure its output reports, the stage is debugging. A run sent to the background does not count, since its result comes later.
- Below, pinned: the goal of the whole session, drawn from what you asked for. Haiku keeps it until your requests move on. The box sees only what you ask after it loads, so in a resumed session the goal starts from the transcript.
- The recap and the goal use everyday words, with no jargon, no abbreviations and no names of files or code.
- The box updates as the session works, with no periodic polling. Each tool call, and each helper agent that starts or ends, has it read the stage again, two seconds after the last of a burst; a steady stream of events still gets a check about every ten seconds. It asks Haiku for a new recap when a turn of the session ends, and every fifth call of a long turn, at most once every ten seconds. A recap due sooner waits out the ten seconds, then reads what is newest. When the transcript has not changed, it asks nothing.
- After a `/resume`, the box recaps the transcript the resume brings once the engine has it in place. After a `/clear` it waits for new activity.
- While the box waits undrawn (opened on its own on a terminal too narrow for it, or with no app attached) it reads nothing. A recap that came due meanwhile is written once the box is drawn. A box drawn but behind another tab still reads.

`/recap-box` hides the box while it shows, and shows it again while it is hidden or behind another pane.

`/recap-box history` turns the history on or off. With it on, the recap and the goal stay at the top of the box, and the session's earlier recaps run below them under a dotted line, the newest first, each dimmed under the stage it was written in. Scroll down in the box for older ones with the mouse wheel in the fullscreen layout, one recap a step. From the keyboard, ctrl+x tab moves the focus to the box: the down arrow or Page Down moves one recap older, Page Up one newer, and Home and End go to the newest and the oldest. Esc moves the focus back to the prompt. The box keeps your place as new recaps come in. Where it sits above the prompt (outside the fullscreen layout, or in a terminal under 110 columns), the box is too short to hold the recap and goal still, so it scrolls as a whole. It keeps the last 200, and a /clear or /resume starts the list over.

Later sessions keep the setting; sessions already open keep theirs until they restart.

`/recap-box upgrade` installs the newest version and reloads the plugins. While one waits, the box says so at its top: see [Updates](#updates).

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

The box checks on its own, whatever those variables say. While `main` holds a commit the copy running lacks, it shows `Update available: /recap-box upgrade` at its top. It asks GitHub when a session starts at the prompt or a surface attaches, then every hour. A copy run from a clone (`--plugin-dir`) never shows it.

To update right away, run `/recap-box upgrade`. It runs these two commands with the `claude` on your `PATH`, then reloads the plugins of that session:

```
claude plugin marketplace update recap-box && claude plugin update recap-box@recap-box
```

Where `claude` is not on the `PATH`, as in the desktop app, run them from a shell. Then run `/recap-box upgrade` or `/reload-plugins` in any other session that is already open.

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
