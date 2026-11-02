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
