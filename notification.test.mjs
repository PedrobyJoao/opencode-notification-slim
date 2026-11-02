import assert from "node:assert/strict"
import { EventEmitter } from "node:events"
import { readFileSync } from "node:fs"
import { stripTypeScriptTypes } from "node:module"
import * as path from "node:path"
import { test } from "node:test"
import * as url from "node:url"
import { createContext, SourceTextModule, SyntheticModule } from "node:vm"

const sourceURL = new URL("../tui.ts", import.meta.url)
const source = stripTypeScriptTypes(readFileSync(sourceURL, "utf8"))

async function fixture(options = {}) {
  const calls = [], warnings = []
  const renderer = new EventEmitter()
  const events = new Map()
  const sessions = new Map([
    ["current", { title: "Current session" }],
    ["other", { title: "Other session" }],
    ["child", { title: "Subagent", parentID: "current" }],
    ["other-child", { title: "Other subagent", parentID: "other" }],
  ])
  let route = { type: "session", sessionID: "current" }
  let config = options.config ?? { sound: false }
  const context = createContext({
    process: { env: { XDG_CONFIG_HOME: "/test/config" } },
    console: { warn: message => warnings.push(message) },
    setTimeout, clearTimeout, URL,
  })
  const mocks = {
    "@opencode/plugin/tui": { Plugin: { define: value => value } },
    "node:child_process": { spawn(command, args) {
      calls.push({ command, args })
      const child = new EventEmitter()
      child.kill = () => { child.emit("close", null); return true }
      queueMicrotask(() => child.emit("close", options.failedPlayers?.includes(command) ? 1 : 0))
      return child
    } },
    "node:fs/promises": {
      async readFile() {
        if (options.readPending) await options.readPending
        if (options.missingConfig) throw Object.assign(new Error("missing"), { code: "ENOENT" })
        return JSON.stringify(config)
      },
      async access() { if (options.inaccessible) throw new Error("unreadable") },
    },
    "node:os": { homedir: () => "/test/home" },
    "node:path": path,
    "node:url": url,
  }
  const module = new SourceTextModule(source, {
    context,
    identifier: sourceURL.href,
    initializeImportMeta(meta) { meta.url = sourceURL.href },
  })
  await module.link(name => {
    const exports = mocks[name]
    return new SyntheticModule(Object.keys(exports), function () {
      for (const [key, value] of Object.entries(exports)) this.setExport(key, value)
    }, { context })
  })
  await module.evaluate()
  const dispose = module.namespace.default.setup({
    renderer,
    ui: { router: { current: () => route } },
    data: {
      session: {
        get: id => sessions.get(id),
        root(id) {
          const session = sessions.get(id)
          return session ? session.parentID ?? id : undefined
        },
      },
      on(name, callback) { events.set(name, callback); return () => events.delete(name) },
    },
  })
  return {
    calls, warnings, renderer, events, sessions, dispose,
    route(value) { route = value },
    config(value) { config = value },
    emit(id = "current", kind = "complete") {
      events.get(kind === "complete" ? "session.execution.succeeded" : "permission.asked")({ data: { sessionID: id } })
    },
    notifications: () => calls.filter(call => call.command === "notify-send"),
    sounds: () => calls.filter(call => call.command !== "notify-send"),
  }
}

const settle = () => new Promise(setImmediate)

test("a background TUI does not notify for the session in another focused TUI", async t => {
  const focused = await fixture(), background = await fixture()
  t.after(focused.dispose)
  t.after(background.dispose)
  focused.renderer.emit("focus")
  background.route({ type: "session", sessionID: "other" })
  background.renderer.emit("blur")
  focused.emit()
  background.emit()
  await settle()
  assert.equal(focused.calls.length, 0)
  assert.equal(background.calls.length, 0)
})

for (const kind of ["complete", "permission"]) {
  for (const [id, expected] of [["current", 1], ["child", 1], ["other", 0], ["other-child", 0], ["unknown", 0]]) {
    test(`${kind}: blurred TUI only notifies for its displayed session family (${id})`, async t => {
      const f = await fixture()
      t.after(f.dispose)
      f.renderer.emit("blur")
      f.emit(id, kind)
      await settle()
      assert.equal(f.notifications().length, expected)
    })
  }
}

test("focused or unknown terminal focus stays silent", async t => {
  const f = await fixture()
  t.after(f.dispose)
  f.emit()
  f.renderer.emit("focus")
  f.emit()
  await settle()
  assert.equal(f.calls.length, 0)
})

test("home screen does not claim another session's notifications", async t => {
  const f = await fixture()
  t.after(f.dispose)
  f.route({ type: "home" })
  f.renderer.emit("blur")
  f.emit()
  await settle()
  assert.equal(f.calls.length, 0)
})

for (const action of ["focus", "route", "dispose"]) {
  test(`${action} while reading settings cancels pending notifications and sound`, async t => {
    let release
    const readPending = new Promise(resolve => { release = resolve })
    const f = await fixture({ config: { sound: true }, readPending })
    t.after(f.dispose)
    f.renderer.emit("blur")
    f.emit()
    if (action === "focus") f.renderer.emit("focus")
    if (action === "route") f.route({ type: "session", sessionID: "other" })
    if (action === "dispose") f.dispose()
    release()
    await settle()
    assert.equal(f.calls.length, 0)
  })
}

for (const [name, sounds, expected] of [
  ["absolute paths with spaces", { complete: "/my sounds/done.wav" }, "/my sounds/done.wav"],
  ["home expansion", { complete: "~/Sounds/done.WAV" }, "/test/home/Sounds/done.WAV"],
  ["relative paths", { complete: "sounds/done.wav" }, "/test/config/opencode/sounds/done.wav"],
  ["bundled fallback", { permission: "/custom/ask.wav" }, url.fileURLToPath(new URL("../complete.wav", import.meta.url))],
]) {
  test(`sound: ${name}`, async t => {
    const f = await fixture({ config: { sound: true, sounds } })
    t.after(f.dispose)
    f.renderer.emit("blur")
    f.emit()
    await settle()
    assert.equal(f.notifications().length, 1)
    assert.deepEqual(f.sounds().map(call => call.args[0]), [expected])
  })
}

test("custom permission sound is selected independently", async t => {
  const f = await fixture({ config: { sounds: { permission: "~/ask.wav" } } })
  t.after(f.dispose)
  f.renderer.emit("blur")
  f.emit("current", "permission")
  await settle()
  assert.deepEqual(f.sounds().map(call => call.args[0]), ["/test/home/ask.wav"])
})

for (const settings of [{ sound: false }, { sounds: null }, { sounds: { complete: "bad.mp3" } }]) {
  test(`desktop notifications survive disabled or invalid sound settings: ${JSON.stringify(settings)}`, async t => {
    const f = await fixture({ config: settings })
    t.after(f.dispose)
    f.renderer.emit("blur")
    f.emit()
    await settle()
    assert.equal(f.notifications().length, 1)
    assert.equal(f.sounds().length, 0)
  })
}

test("inaccessible custom WAV skips playback, not the notification", async t => {
  const f = await fixture({ config: { sounds: { complete: "/missing.wav" } }, inaccessible: true })
  t.after(f.dispose)
  f.renderer.emit("blur")
  f.emit()
  await settle()
  assert.equal(f.notifications().length, 1)
  assert.equal(f.sounds().length, 0)
  assert.equal(f.warnings.length, 1)
})

test("settings are reread for each notification", async t => {
  const f = await fixture()
  t.after(f.dispose)
  f.renderer.emit("blur")
  f.emit()
  await settle()
  f.config({ sounds: { complete: "/new.wav" } })
  f.emit()
  await settle()
  assert.equal(f.notifications().length, 2)
  assert.deepEqual(f.sounds().map(call => call.args[0]), ["/new.wav"])
})

test("cleanup removes focus and server-event listeners", async () => {
  const f = await fixture()
  f.dispose()
  assert.equal(f.renderer.listenerCount("focus"), 0)
  assert.equal(f.renderer.listenerCount("blur"), 0)
  assert.equal(f.events.size, 0)
})
