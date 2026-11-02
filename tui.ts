import { Plugin } from "@opencode/plugin/tui"
import { spawn } from "node:child_process"
import { access, readFile } from "node:fs/promises"
import { homedir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"

// Linux desktop notifications, independent of the terminal's notification support.
// Config: $XDG_CONFIG_HOME/opencode/opencode-notification-slim.json
// Sounds: complete.wav and permission.wav beside this file (optional).
const configPath = join(
  process.env.XDG_CONFIG_HOME || join(homedir(), ".config"),
  "opencode",
  "opencode-notification-slim.json",
)

export default Plugin.define({
  id: "opencode-notification-slim",
  setup(ctx) {
    // Fail closed: only an actual terminal blur event enables notifications.
    // Terminals/multiplexers without focus reporting will stay silent.
    let blurred = false
    let disposed = false
    let generation = 0
    const children = new Set<() => void>()
    const warnings = new Set<string>()

    const warn = (message: string) => {
      if (warnings.has(message) || disposed) return
      warnings.add(message)
      console.warn(`[opencode-notification-slim] ${message}`)
    }

    const stop = () => {
      blurred = false
      generation++
      for (const terminate of children) terminate()
    }
    const blur = () => { blurred = true }
    ctx.renderer.on("focus", stop)
    ctx.renderer.on("blur", blur)

    const notify = async (kind: "complete" | "permission", sessionID: string) => {
      if (!blurred || disposed) return
      const current = generation
      const allowed = () => blurred && !disposed && generation === current

      // Read on each event so config changes need no restart or file watcher.
      let sound = true
      try {
        const config = JSON.parse(await readFile(configPath, "utf8"))
        if (!config || typeof config !== "object" || Array.isArray(config) ||
          (config.sound !== undefined && typeof config.sound !== "boolean")) {
          throw new Error('Expected an object with an optional boolean "sound"')
        }
        sound = config.sound ?? true
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
          sound = false
          warn(`Cannot read valid config at ${configPath}; sound disabled.`)
        }
      }
      if (!allowed()) return

      // No shell: executable arguments and file paths are passed literally.
      const run = (command: string, args: string[]) => new Promise<boolean>((resolve) => {
        if (!allowed()) return resolve(false)
        const child = spawn(command, args, { stdio: "ignore" })
        let finished = false
        let terminating = false
        let forceTimer: ReturnType<typeof setTimeout> | undefined
        const finish = (ok: boolean) => {
          if (finished) return
          finished = true
          clearTimeout(timer)
          clearTimeout(forceTimer)
          children.delete(terminate)
          resolve(ok)
        }
        const terminate = () => {
          if (finished || terminating) return
          terminating = true
          clearTimeout(timer)
          // Bound cleanup even when a player ignores SIGTERM or never closes.
          forceTimer = setTimeout(() => {
            try {
              child.kill("SIGKILL")
            } catch {
              warn(`Could not force-stop ${command}.`)
            } finally {
              finish(false)
            }
          }, 250)
          forceTimer.unref()
          try {
            child.kill("SIGTERM")
          } catch {
            // Still attempt SIGKILL after the grace period.
          }
        }
        const timer = setTimeout(terminate, 30_000)
        timer.unref()
        children.add(terminate)
        child.once("error", () => {
          if (!terminating) finish(false)
        })
        child.once("close", (code) => finish(!terminating && code === 0))
      })

      const title = ctx.data.session.get(sessionID)?.title?.trim() || "Untitled session"
      const message = kind === "complete" ? "An agent completed its task." : "An agent needs your permission."
      // Suppress the desktop daemon's own sound, including when sound is false.
      // Once submitted to the desktop daemon, a notification cannot be recalled.
      void run("notify-send", ["--app-name=OpenCode", "--hint=boolean:suppress-sound:true", "--", title, message])
        .then((ok) => {
          if (!ok && allowed()) warn("Desktop notification failed. Install libnotify and check your notification daemon.")
        })
        .catch(() => warn("Could not launch notify-send."))

      if (!sound) return
      const wav = fileURLToPath(new URL(`./${kind}.wav`, import.meta.url))
      try {
        await access(wav)
      } catch {
        return // The user can download sound files later.
      }
      for (const player of ["pw-play", "paplay", "aplay"]) {
        if (!allowed() || await run(player, [wav])) return
      }
      warn("Sound playback failed. Install pw-play, paplay, or aplay and check the WAV file.")
    }

    const complete = ctx.data.on("session.execution.succeeded", (event) => {
      void notify("complete", event.data.sessionID).catch(() => warn("Completion notification failed."))
    })
    const permission = ctx.data.on("permission.asked", (event) => {
      void notify("permission", event.data.sessionID).catch(() => warn("Permission notification failed."))
    })

    return () => {
      disposed = true
      stop()
      complete()
      permission()
      ctx.renderer.off("focus", stop)
      ctx.renderer.off("blur", blur)
    }
  },
})
