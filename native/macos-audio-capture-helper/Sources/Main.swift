import Foundation
import AppKit
import ApplicationServices
import AVFoundation
import ScreenCaptureKit
import Darwin

enum Wire {
    static let lock = NSLock()
    static let capabilities = ["dual_track", "system_audio_screencapturekit", "microphone_avaudioengine",
        "dual_start_single_rpc", "clock_mach_host_time", "pause_holes_shared_host_time",
        "durable_subchunk_seal_frame_aligned", "query_devices", "pause_resume", "l0_device_format",
        "parent_pid_watch", "stdin_eof_shutdown", "system_only"]
    static func send(_ value: [String: Any]) {
        lock.lock(); defer { lock.unlock() }
        if let data = try? jsonData(value) { try? FileHandle.standardOutput.write(contentsOf: data) }
    }
    static func hello() {
        send(["type": "hello", "name": "audio-capture-helper", "version": "0.2.0", "protocol_version": 1,
            "platform": "darwin", "capabilities": capabilities,
            "notes": ["macOS 13+", "ScreenCaptureKit system audio is not an output endpoint loopback",
                      "mach host ticks in legacy qpc fields", "no video persistence", "no ASR", "no long-duration reliability claim"]])
    }
    static func result(_ id: String, _ data: [String: Any]) {
        send(["type": "result", "id": id, "result": ["ok": true, "data": data]])
    }
    static func failure(_ id: String, _ error: Error) {
        let failure = error as? HelperFailure ?? HelperFailure("capture_failed", "\(error)")
        send(["type": "result", "id": id, "result": ["ok": false, "error": ["code": failure.code, "message": failure.message]]])
    }
}

@MainActor
final class HelperApp {
    private var root: URL?
    private var session: CaptureSession?
    private var parentPID = getppid()
    private var watcher: Timer?
    private var tail: Task<Void, Never>?
    private var terminating = false
    private var queued = 0

    func start() {
        Wire.hello()
        watcher = Timer.scheduledTimer(withTimeInterval: 1, repeats: true) { [weak self] _ in
            Task { @MainActor in
                guard let self = self else { return }
                if self.parentPID > 1 && kill(self.parentPID, 0) != 0 && errno == ESRCH { self.terminate() }
            }
        }
        DispatchQueue.global(qos: .userInitiated).async {
            var pending = Data()
            while true {
                let data = FileHandle.standardInput.availableData
                if data.isEmpty { DispatchQueue.main.async { self.terminate() }; return }
                pending.append(data)
                while let newline = pending.firstIndex(of: 0x0a) {
                    let line = Data(pending[..<newline])
                    pending.removeSubrange(...newline)
                    if line.count > 65536 {
                        Wire.send(["type": "error", "code": "line_too_long", "message": "JSONL command exceeds 64 KiB"])
                        DispatchQueue.main.async { self.terminate() }; return
                    }
                    DispatchQueue.main.async { self.enqueue(line) }
                }
                if pending.count > 65536 {
                    Wire.send(["type": "error", "code": "line_too_long", "message": "JSONL command exceeds 64 KiB"])
                    DispatchQueue.main.async { self.terminate() }; return
                }
            }
        }
    }

    func enqueue(_ data: Data) {
        guard !terminating else { return }
        guard queued < 128 else { terminate(); return }
        queued += 1
        let previous = tail
        tail = Task { @MainActor in
            await previous?.value
            await self.handle(data)
            self.queued -= 1
        }
    }

    func terminate() {
        guard !terminating else { return }
        terminating = true
        watcher?.invalidate()
        // EOF/parent death must not leave a permission or framework hang alive indefinitely.
        // A forced exit leaves durable committed chunks and a recoverable recording manifest.
        DispatchQueue.global().asyncAfter(deadline: .now() + 8) { Darwin._exit(2) }
        let previous = tail
        Task { @MainActor in
            await previous?.value
            _ = await self.session?.stop()
            Darwin.exit(0)
        }
    }

    private func handle(_ data: Data) async {
        guard let object = try? JSONSerialization.jsonObject(with: data),
              let command = object as? [String: Any], let cmd = command["cmd"] as? String,
              let id = command["id"] as? String, !id.isEmpty, id.utf8.count <= 256 else {
            Wire.send(["type": "error", "code": "invalid_command", "message": "Expected a JSON object with cmd and id"]); return
        }
        Wire.send(["type": "ack", "id": id, "command": cmd])
        do {
            switch cmd {
            case "hello":
                Wire.hello(); Wire.result(id, ["name": "audio-capture-helper", "version": "0.2.0", "protocol_version": 1, "capabilities": Wire.capabilities])
            case "ping": Wire.result(id, ["pong": true, "sessionId": session?.sessionID ?? ""])
            case "configure":
                guard session == nil else { throw HelperFailure("already_capturing", "Stop capture before reconfiguring") }
                guard let value = command["session_root"] as? String else { throw HelperFailure("path_empty", "session_root is required") }
                let configured = try canonicalDirectory(value)
                if let pid = command["parent_pid"] as? Int {
                    guard pid > 1, pid <= Int(Int32.max), pid != Int(getpid()) else { throw HelperFailure("invalid_parent", "Invalid parent PID") }
                    parentPID = pid_t(pid)
                }
                root = configured
                Wire.result(id, ["configured": true, "sessionRoot": configured.path, "parentPid": parentPID])
            case "query_devices":
                let microphones = microphoneDevices()
                var render: [[String: Any]] = []
                if CGPreflightScreenCaptureAccess() {
                    let content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: true)
                    render = content.displays.enumerated().map { index, display in
                        ["id": "display:\(display.displayID)", "name": "System audio (display \(display.displayID))",
                         "flow": "render", "is_default": index == 0, "captureScope": "screencapturekit_display_mix"]
                    }
                }
                Wire.result(id, ["devices": microphones, "capture": microphones, "render": render,
                    "permissions": ["microphone": AVCaptureDevice.authorizationStatus(for: .audio).rawValue,
                                    "screen": CGPreflightScreenCaptureAccess()],
                    "notes": ["render entries are ScreenCaptureKit display filters, not hardware output endpoints"]])
            case "start":
                guard let root = root else { throw HelperFailure("not_configured", "Configure session_root first") }
                guard session == nil else { throw HelperFailure("already_capturing", "Stop the active session first") }
                guard let sessionID = command["session_id"] as? String, !sessionID.isEmpty, sessionID.utf8.count <= 256 else {
                    throw HelperFailure("invalid_session_id", "session_id is required")
                }
                let mode = command["capture_mode"] as? String ?? command["track"] as? String ??
                    (command["system"] != nil ? (command["microphone"] != nil ? "dual" : "system") : "microphone")
                guard ["dual", "microphone", "system"].contains(mode) else { throw HelperFailure("invalid_capture_mode", "Use dual, microphone or system") }
                guard command["track"] == nil || command["track"] as? String == mode else {
                    throw HelperFailure("invalid_track", "track must match capture_mode")
                }
                let capture = CaptureSession(sessionID: sessionID, mode: mode, emit: Wire.send)
                session = capture
                do { Wire.result(id, try await capture.start(root: root, command: command)) }
                catch {
                    _ = await capture.stop(reason: "startup_failed")
                    session = nil
                    throw error
                }
            case "pause", "resume":
                guard let session = session else { throw HelperFailure("not_started", "No active session") }
                Wire.result(id, try session.pause(cmd == "pause"))
            case "stop":
                let result = await session?.stop() ?? ["stopped": true, "idempotent": true]
                session = nil
                if result["sessionFaulted"] as? Bool == true {
                    Wire.failure(id, HelperFailure("capture_tail_failed", "Capture stopped with an archive fault; retain and recover committed PCM and current.part"))
                } else { Wire.result(id, result) }
            case "shutdown":
                let _ = await session?.stop()
                session = nil
                Wire.result(id, ["shutdown": true])
                terminating = true
                Darwin.exit(0)
            default: throw HelperFailure("unknown_cmd", "Unknown helper command")
            }
        } catch { Wire.failure(id, error) }
    }
}

@main
struct Main {
    @MainActor static func main() {
        signal(SIGPIPE, SIG_IGN)
        let args = CommandLine.arguments
        if args.count == 3, args[1] == "--self-test-system-pause" {
            do {
                Wire.result("system-pause-test", try systemPauseArchiveSelfTest(directory: canonicalDirectory(args[2])))
            } catch { Wire.failure("system-pause-test", error); Darwin.exit(1) }
            return
        }
        if args.count == 2, args[1] == "--request-screen-access" {
            print(CGPreflightScreenCaptureAccess() || CGRequestScreenCaptureAccess() ? "true" : "false")
            return
        }
        if args.count == 3, args[1] == "--self-test-archive" {
            do {
                let directory = try canonicalDirectory(args[2])
                let origin = HostClock.now()
                let writer = try TrackWriter(directory: directory, sessionID: "native-self-test", track: "microphone",
                    format: PCMFormat(rate: 1000, channels: 1), origin: origin, subchunkMS: 100, progress: { _ in })
                try writer.markRecording()
                var samples = [Float](repeating: 0.25, count: 225)
                let data = samples.withUnsafeMutableBytes { Data($0) }
                let start = HostClock.advance(origin, frames: 250, rate: 1000)
                try writer.write(data, frames: 225, tick: start, devicePosition: 0, discontinuity: false)
                let result = try writer.finish()
                Wire.result("self-test", result)
            } catch { Wire.failure("self-test", error); Darwin.exit(1) }
            return
        }
        if args.count == 2, args[1] == "--foreground-app" {
            if let application = NSWorkspace.shared.frontmostApplication { print(application.processIdentifier) }
            return
        }
        if args.count == 3, args[1] == "--paste-to-app" {
            guard let pid = pid_t(args[2]), pid > 1, AXIsProcessTrusted(),
                  let app = NSRunningApplication(processIdentifier: pid), !app.isTerminated,
                  app.activate(options: [.activateIgnoringOtherApps]) else { Darwin.exit(1) }
            let deadline = Date().addingTimeInterval(1.5)
            while NSWorkspace.shared.frontmostApplication?.processIdentifier != pid, Date() < deadline {
                RunLoop.current.run(until: Date().addingTimeInterval(0.02))
            }
            guard NSWorkspace.shared.frontmostApplication?.processIdentifier == pid,
                  let source = CGEventSource(stateID: .combinedSessionState),
                  let down = CGEvent(keyboardEventSource: source, virtualKey: 9, keyDown: true),
                  let up = CGEvent(keyboardEventSource: source, virtualKey: 9, keyDown: false) else { Darwin.exit(1) }
            down.flags = .maskCommand; up.flags = .maskCommand
            down.postToPid(pid); up.postToPid(pid)
            return
        }
        guard args.count == 1 else { Darwin.exit(64) }
        let app = HelperApp()
        app.start()
        signal(SIGTERM, SIG_IGN); signal(SIGINT, SIG_IGN)
        let term = DispatchSource.makeSignalSource(signal: SIGTERM, queue: .main)
        let interrupt = DispatchSource.makeSignalSource(signal: SIGINT, queue: .main)
        term.setEventHandler { Task { @MainActor in app.terminate() } }
        interrupt.setEventHandler { Task { @MainActor in app.terminate() } }
        term.resume(); interrupt.resume()
        withExtendedLifetime((app, term, interrupt)) { RunLoop.main.run() }
    }
}
