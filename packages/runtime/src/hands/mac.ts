/**
 * Kumi's hands on a Mac: a small Swift program that drives Live through macOS Accessibility. It stays
 * running beside Kumi and takes one JSON request a line on stdin, answering one JSON line on stdout, so
 * each command costs milliseconds: press a menu item (found by its title anywhere in Live's menus),
 * press keys, read and answer Live's dialogs, list its windows. It brings Live to the front only when a
 * command needs it and gives the front back after. Kumi compiles it once (the release carries it built).
 */

/** Bumped whenever the program changes: Kumi builds (or uses) the matching one. */
export const HANDS_VERSION = 1;

export const MAC_SOURCE = String.raw`// Kumi's hands (made by Kumi). One JSON request a line on stdin, one JSON answer a line on stdout.
import Cocoa
import ApplicationServices

let version = ${HANDS_VERSION}
let liveBundles = ["com.ableton.live"]

func emit(_ object: [String: Any]) {
  if let data = try? JSONSerialization.data(withJSONObject: object, options: []) {
    FileHandle.standardOutput.write(data)
    FileHandle.standardOutput.write("\n".data(using: .utf8)!)
  }
}

func live() -> NSRunningApplication? {
  for bundle in liveBundles { if let app = NSRunningApplication.runningApplications(withBundleIdentifier: bundle).first { return app } }
  return NSWorkspace.shared.runningApplications.first { ($0.bundleIdentifier ?? "").hasPrefix("com.ableton.live") }
}

func value(_ element: AXUIElement, _ name: String) -> AnyObject? {
  var result: AnyObject?
  return AXUIElementCopyAttributeValue(element, name as CFString, &result) == .success ? result : nil
}
func children(_ element: AXUIElement) -> [AXUIElement] { (value(element, kAXChildrenAttribute as String) as? [AXUIElement]) ?? [] }
func title(_ element: AXUIElement) -> String { (value(element, kAXTitleAttribute as String) as? String) ?? "" }
func role(_ element: AXUIElement) -> String { (value(element, kAXRoleAttribute as String) as? String) ?? "" }
func enabled(_ element: AXUIElement) -> Bool { (value(element, kAXEnabledAttribute as String) as? Bool) ?? true }

/** Live's menu items, with their place: [["Edit", "Group Tracks"], …], each with whether it's enabled and its key. */
func walk(_ element: AXUIElement, _ path: [String], _ into: inout [[String: Any]], _ depth: Int) {
  if depth > 6 { return }
  for child in children(element) {
    let kind = role(child)
    if kind == (kAXMenuItemRole as String) || kind == (kAXMenuBarItemRole as String) {
      let name = title(child)
      if name.isEmpty { continue }
      let here = path + [name]
      let submenu = children(child).first { role($0) == (kAXMenuRole as String) }
      if let submenu = submenu { walk(submenu, here, &into, depth + 1) }
      else if kind == (kAXMenuItemRole as String) {
        var item: [String: Any] = ["path": here, "enabled": enabled(child)]
        if let key = value(child, kAXMenuItemCmdCharAttribute as String) as? String, !key.isEmpty {
          item["key"] = key
          item["modifiers"] = (value(child, kAXMenuItemCmdModifiersAttribute as String) as? Int) ?? 0
        }
        into.append(item)
      }
    } else if kind == (kAXMenuRole as String) { walk(child, path, &into, depth + 1) }
  }
}

func menuBar(_ app: NSRunningApplication) -> AXUIElement? {
  let element = AXUIElementCreateApplication(app.processIdentifier)
  guard let bar = value(element, kAXMenuBarAttribute as String) else { return nil }
  return (bar as! AXUIElement)
}

/** The menu item at a path of titles ("Edit", "Group Tracks"); a title can be its start ("Freeze"). */
func item(_ bar: AXUIElement, _ path: [String]) -> AXUIElement? {
  var current: AXUIElement = bar
  for (index, name) in path.enumerated() {
    var holder = current
    if index > 0, let submenu = children(current).first(where: { role($0) == (kAXMenuRole as String) }) { holder = submenu }
    let found = children(holder).first { title($0) == name } ?? children(holder).first { title($0).lowercased().hasPrefix(name.lowercased()) }
    guard let next = found else { return nil }
    current = next
  }
  return current
}

let keyCodes: [String: CGKeyCode] = [
  "a": 0, "s": 1, "d": 2, "f": 3, "h": 4, "g": 5, "z": 6, "x": 7, "c": 8, "v": 9, "b": 11, "q": 12, "w": 13, "e": 14, "r": 15, "y": 16, "t": 17,
  "1": 18, "2": 19, "3": 20, "4": 21, "6": 22, "5": 23, "=": 24, "9": 25, "7": 26, "-": 27, "8": 28, "0": 29, "]": 30, "o": 31, "u": 32, "[": 33,
  "i": 34, "p": 35, "return": 36, "enter": 36, "l": 37, "j": 38, "'": 39, "k": 40, ";": 41, "\\": 42, ",": 43, "/": 44, "n": 45, "m": 46, ".": 47,
  "tab": 48, "space": 49, "\u{60}": 50, "delete": 51, "backspace": 51, "escape": 53, "esc": 53, "f1": 122, "f2": 120, "f3": 99, "f4": 118, "f5": 96, "f6": 97,
  "f7": 98, "f8": 100, "f9": 101, "f10": 109, "f11": 103, "f12": 111, "home": 115, "pageup": 116, "forwarddelete": 117, "end": 119, "pagedown": 121,
  "left": 123, "right": 124, "down": 125, "up": 126,
]

/** "cmd+shift+r": the key and its modifiers, pressed and released in the app (no focus needed for most). */
func press(_ combo: String, _ app: NSRunningApplication) -> String? {
  var flags = CGEventFlags()
  var key: CGKeyCode?
  for part in combo.lowercased().split(separator: "+").map(String.init) {
    switch part {
    case "cmd", "command": flags.insert(.maskCommand)
    case "shift": flags.insert(.maskShift)
    case "alt", "option", "opt": flags.insert(.maskAlternate)
    case "ctrl", "control": flags.insert(.maskControl)
    default: key = keyCodes[part]
    }
  }
  guard let code = key else { return "Kumi doesn't know the key in \(combo)." }
  let source = CGEventSource(stateID: .hidSystemState)
  guard let down = CGEvent(keyboardEventSource: source, virtualKey: code, keyDown: true), let up = CGEvent(keyboardEventSource: source, virtualKey: code, keyDown: false) else { return "The keys couldn't be made." }
  down.flags = flags; up.flags = flags
  down.post(tap: .cghidEventTap); up.post(tap: .cghidEventTap)
  return nil
}

/** Bring an app to the front: macOS 14 dropped "ignoring other apps", which 13 still needs. */
func activate(_ app: NSRunningApplication) {
  if #available(macOS 14.0, *) { app.activate() } else { app.activate(options: [.activateIgnoringOtherApps]) }
}

/** Bring Live to the front (and say what was in front, to give it back). */
func front(_ app: NSRunningApplication) -> NSRunningApplication? {
  let before = NSWorkspace.shared.frontmostApplication
  if before?.processIdentifier != app.processIdentifier {
    activate(app)
    let deadline = Date().addingTimeInterval(1.0)
    while NSWorkspace.shared.frontmostApplication?.processIdentifier != app.processIdentifier && Date() < deadline { usleep(5_000) }
  }
  return before?.processIdentifier == app.processIdentifier ? nil : before
}

/** Live's dialog, if one is up: its words and buttons. */
func dialog(_ app: NSRunningApplication) -> AXUIElement? {
  let element = AXUIElementCreateApplication(app.processIdentifier)
  let windows = (value(element, kAXWindowsAttribute as String) as? [AXUIElement]) ?? []
  return windows.first { window in
    let subrole = (value(window, kAXSubroleAttribute as String) as? String) ?? ""
    let modal = (value(window, kAXModalAttribute as String) as? Bool) ?? false
    return modal || subrole == (kAXDialogSubrole as String) || subrole == (kAXSystemDialogSubrole as String)
  }
}
func texts(_ element: AXUIElement, _ depth: Int = 0) -> (words: [String], buttons: [String]) {
  var words: [String] = []; var buttons: [String] = []
  if depth > 8 { return (words, buttons) }
  for child in children(element) {
    let kind = role(child)
    if kind == (kAXButtonRole as String) { let name = title(child); if !name.isEmpty { buttons.append(name) } }
    else if kind == (kAXStaticTextRole as String) { if let text = value(child, kAXValueAttribute as String) as? String, !text.isEmpty { words.append(text) } }
    let deeper = texts(child, depth + 1); words += deeper.words; buttons += deeper.buttons
  }
  return (words, buttons)
}
func button(_ element: AXUIElement, _ name: String, _ depth: Int = 0) -> AXUIElement? {
  if depth > 8 { return nil }
  for child in children(element) {
    if role(child) == (kAXButtonRole as String) && title(child).lowercased() == name.lowercased() { return child }
    if let found = button(child, name, depth + 1) { return found }
  }
  return nil
}

while let line = readLine() {
  guard let data = line.data(using: .utf8), let request = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] else { continue }
  let id = request["id"] ?? 0
  let op = (request["op"] as? String) ?? ""
  let started = Date()
  var answer: [String: Any] = ["id": id]
  func done(_ fields: [String: Any]) { for (key, value) in fields { answer[key] = value }; answer["ms"] = Int(Date().timeIntervalSince(started) * 1000); emit(answer) }
  if op == "version" { done(["ok": true, "version": version]); continue }
  if op == "trusted" {
    let prompt = (request["prompt"] as? Bool) ?? false
    let options = [kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: prompt] as CFDictionary
    done(["ok": true, "trusted": AXIsProcessTrustedWithOptions(options)]); continue
  }
  guard AXIsProcessTrusted() else { done(["ok": false, "error": "untrusted"]); continue }
  guard let app = live() else { done(["ok": false, "error": "no-live"]); continue }
  switch op {
  case "menus":
    guard let bar = menuBar(app) else { done(["ok": false, "error": "no-menus"]); break }
    var items: [[String: Any]] = []
    walk(bar, [], &items, 0)
    done(["ok": true, "items": items])
  case "menu":
    let path = (request["path"] as? [String]) ?? []
    guard let bar = menuBar(app), let target = item(bar, path) else { done(["ok": false, "error": "no-item"]); break }
    if !enabled(target) { done(["ok": false, "error": "disabled"]); break }
    let back = (request["front"] as? Bool) == true ? front(app) : nil
    let result = AXUIElementPerformAction(target, kAXPressAction as CFString)
    if let back = back, (request["giveBack"] as? Bool) != false { usleep(UInt32(((request["settleMs"] as? Int) ?? 60) * 1000)); activate(back) }
    done(result == .success ? ["ok": true] : ["ok": false, "error": "press-failed", "code": result.rawValue])
  case "keys":
    let combos = (request["keys"] as? [String]) ?? []
    let back = front(app)
    var failure: String?
    for combo in combos { if let problem = press(combo, app) { failure = problem; break }; usleep(UInt32(((request["gapMs"] as? Int) ?? 25) * 1000)) }
    if let back = back, (request["giveBack"] as? Bool) != false { usleep(UInt32(((request["settleMs"] as? Int) ?? 60) * 1000)); activate(back) }
    done(failure == nil ? ["ok": true] : ["ok": false, "error": failure!])
  case "dialog":
    guard let window = dialog(app) else { done(["ok": true, "open": false]); break }
    let read = texts(window)
    done(["ok": true, "open": true, "title": title(window), "words": read.words, "buttons": read.buttons])
  case "answer":
    let name = (request["button"] as? String) ?? ""
    guard let window = dialog(app), let target = button(window, name) else { done(["ok": false, "error": "no-button"]); break }
    let result = AXUIElementPerformAction(target, kAXPressAction as CFString)
    done(result == .success ? ["ok": true] : ["ok": false, "error": "press-failed"])
  case "windows":
    let element = AXUIElementCreateApplication(app.processIdentifier)
    let windows = (value(element, kAXWindowsAttribute as String) as? [AXUIElement]) ?? []
    done(["ok": true, "windows": windows.map { ["title": title($0), "subrole": (value($0, kAXSubroleAttribute as String) as? String) ?? ""] }])
  case "front":
    let back = front(app)
    done(["ok": true, "previous": back?.bundleIdentifier ?? ""])
  default:
    done(["ok": false, "error": "unknown-op"])
  }
}
`;
