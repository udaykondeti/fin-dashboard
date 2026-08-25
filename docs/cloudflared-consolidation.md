# Cloudflared consolidation — remaining sudo steps

**Status as of 2026-08-25:** partially fixed. Went from 3 concurrent connectors to 2.
The last step needs `sudo`, which an agent session does not have.

## What the problem is

Five cloudflared plists existed on this Mac Mini, and three of them ran the **same
tunnel** (`kirakon-mini`, `0cd710cd-152e-44f8-af5b-105e1803c435`) simultaneously:

| PID | User | Supervisor | Config |
|---|---|---|---|
| 2470 | root | `/Library/LaunchDaemons/com.cloudflare.cloudflared.plist` | `/etc/cloudflared/config.yml` |
| 2873 | root | `/Library/LaunchDaemons/com.kirakon.cloudflared.plist` | `~/.cloudflared/config.yml` |
| 3446 | kiran | `~/Library/LaunchAgents/com.kirakon.cloudflared.plist` | `~/.cloudflared/config.yml` |

Plus two Homebrew plists (`/Library/LaunchDaemons/homebrew.mxcl.cloudflared.plist`
and the matching LaunchAgent) which were **not running** — `brew services` reports
exit status 78 for them.

Cloudflare confirmed 3 registered connectors holding 12 edge connections, where 1
connector / 4 connections is correct.

Both config files are **byte-identical**, so this degrades rather than breaks: all
three connectors reach the same origin. The real hazard is subtler — edit the config
and restart one supervisor, and it looks like the change is live while two stale
connectors keep serving the old ingress. That is a genuinely confusing failure to
debug at 2am.

## Already done (no sudo needed)

- Stopped the user LaunchAgent: `launchctl bootout gui/$UID/com.kirakon.cloudflared`
- Moved both user-level plists to `~/backups/disabled-launchagents/` so they cannot
  reload at login
- Booted out the stale `homebrew.mxcl.cloudflared` user-domain job
- Verified: 3 connectors → **2**, app still serving 200

## Remaining steps (need sudo)

Keep `com.cloudflare.cloudflared` — it is the canonical daemon created by
`cloudflared service install`, runs as root at boot without anyone logging in, and
reads `/etc/cloudflared/config.yml`. Remove the rest.

```bash
# 1. Confirm the current state first
cloudflared tunnel info 0cd710cd-152e-44f8-af5b-105e1803c435
ps -eo pid,user,command | grep '[c]loudflared'

# 2. Back up every plist before touching anything
sudo mkdir -p /var/backups/cloudflared-plists
sudo cp /Library/LaunchDaemons/com.kirakon.cloudflared.plist \
        /Library/LaunchDaemons/homebrew.mxcl.cloudflared.plist \
        /var/backups/cloudflared-plists/ 2>/dev/null

# 3. Stop and unload the duplicate daemon
sudo launchctl bootout system/com.kirakon.cloudflared
sudo launchctl disable system/com.kirakon.cloudflared

# 4. Remove the broken Homebrew daemon (exit 78, not running)
sudo launchctl bootout system/homebrew.mxcl.cloudflared 2>/dev/null
brew services stop cloudflared 2>/dev/null

# 5. Move the redundant plists out of the load path
sudo mv /Library/LaunchDaemons/com.kirakon.cloudflared.plist \
        /var/backups/cloudflared-plists/
sudo mv /Library/LaunchDaemons/homebrew.mxcl.cloudflared.plist \
        /var/backups/cloudflared-plists/

# 6. Verify — expect exactly ONE process and ONE connector
ps -eo pid,user,command | grep '[c]loudflared'
sleep 20
cloudflared tunnel info 0cd710cd-152e-44f8-af5b-105e1803c435

# 7. Confirm the site still answers, from a DIFFERENT machine or a browser.
#    Do not test from the Mac Mini itself — requests hairpin out to Cloudflare
#    and back, and a timeout there means nothing.
```

## Rollback

If the site stops answering after step 3, put it straight back:

```bash
sudo cp /var/backups/cloudflared-plists/com.kirakon.cloudflared.plist /Library/LaunchDaemons/
sudo launchctl enable system/com.kirakon.cloudflared
sudo launchctl bootstrap system /Library/LaunchDaemons/com.kirakon.cloudflared.plist
```

User-level agents are recoverable from `~/backups/disabled-launchagents/`.

## Worth doing at the same time

- **cloudflared is outdated:** running 2026.5.2, current is 2026.8.2. The log warns
  daily. `brew upgrade cloudflared` then restart the one remaining daemon.
- **Config lives in two places.** `/etc/cloudflared/config.yml` and
  `~/.cloudflared/config.yml` are byte-identical today. Once only the `/etc` daemon
  runs, `~/.cloudflared/config.yml` becomes dead weight that will drift — consider
  deleting it, or keep it solely as the deploy source and copy it into `/etc` on
  change. Either way, pick one and write it down.
- **`brew services list` shows `nginx` in error state (1)** as well. Nginx is running
  under some other supervisor. Since nginx is not in the public request path, this is
  low priority — but it does mean nginx may not survive a reboot.
