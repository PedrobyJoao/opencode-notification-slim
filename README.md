# opencode-notification-slim

A replacement for when Opencode's builtin notification
doesn't work.

> It seems with Alacritty doesn't work because of:
>
> https://github.com/alacritty/alacritty/issues/7105

The ideal fix is to open a PR to Opencode, putting a
fallback to `notify-send` or something.

## How it works

Two notifications:

1. Complete (when it's answered)
2. Asked permission

## Settings

> You may also disable Opencode's builtin notification just in case

Edit `~/.config/opencode/opencode-notification-slim.json` (or
`$XDG_CONFIG_HOME/opencode/opencode-notification-slim.json`):

```json
{
  "sound": true,
  "sounds": {
    "complete": "~/Sounds/complete.wav",
    "permission": "~/Sounds/permission.wav"
  }
}
```

## Tests

With Node.js 24 or newer:

```sh
node --experimental-vm-modules --test notification.test.mjs
```

These tests mock terminal focus, server events, filesystem reads, and notification
players; they do not verify live terminal focus reporting or audio output.
