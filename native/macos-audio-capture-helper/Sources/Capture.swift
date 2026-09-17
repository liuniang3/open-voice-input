import Foundation
import AVFoundation
import AudioToolbox
import CoreAudio
import CoreMedia
import ScreenCaptureKit
import CoreGraphics

func microphoneDevices() -> [[String: Any]] {
    var address = AudioObjectPropertyAddress(mSelector: kAudioHardwarePropertyDevices,
        mScope: kAudioObjectPropertyScopeGlobal, mElement: kAudioObjectPropertyElementMain)
    var size: UInt32 = 0
    guard AudioObjectGetPropertyDataSize(AudioObjectID(kAudioObjectSystemObject), &address, 0, nil, &size) == noErr else { return [] }
    var ids = [AudioDeviceID](repeating: 0, count: Int(size) / MemoryLayout<AudioDeviceID>.size)
    let status = ids.withUnsafeMutableBytes {
        AudioObjectGetPropertyData(AudioObjectID(kAudioObjectSystemObject), &address, 0, nil, &size, $0.baseAddress!)
    }
    guard status == noErr else { return [] }
    var defaultID = AudioDeviceID(0)
    address.mSelector = kAudioHardwarePropertyDefaultInputDevice
    var defaultSize = UInt32(MemoryLayout<AudioDeviceID>.size)
    _ = AudioObjectGetPropertyData(AudioObjectID(kAudioObjectSystemObject), &address, 0, nil, &defaultSize, &defaultID)
    return ids.compactMap { id in
        var streams = AudioObjectPropertyAddress(mSelector: kAudioDevicePropertyStreams,
            mScope: kAudioDevicePropertyScopeInput, mElement: kAudioObjectPropertyElementMain)
        var streamSize: UInt32 = 0
        guard AudioObjectGetPropertyDataSize(id, &streams, 0, nil, &streamSize) == noErr, streamSize > 0 else { return nil }
        var name: CFString = "Microphone" as CFString
        var nameSize = UInt32(MemoryLayout<CFString>.size)
        var property = AudioObjectPropertyAddress(mSelector: kAudioObjectPropertyName,
            mScope: kAudioObjectPropertyScopeGlobal, mElement: kAudioObjectPropertyElementMain)
        _ = AudioObjectGetPropertyData(id, &property, 0, nil, &nameSize, &name)
        return ["id": String(id), "name": name as String, "is_default": id == defaultID, "flow": "capture"]
    }
}

// One serial writer queue owns all mutable archive state. The reservation bounds copied audio.
final class ArchiveSink {
    let queue = DispatchQueue(label: "audio-capture.archive", qos: .userInitiated)
    private let lock = NSLock()
    private var pendingBytes = 0
    private let maxPendingBytes = 16 * 1024 * 1024
    private var accepting = true
    private var failed = false
    private var paused = false
    private var pauseGeneration = 0
    private var positions: [String: Int] = [:]
    private var discarded: [String: Int] = [:]
    private var expectedTicks: [String: UInt64] = [:]
    private var writers: [String: TrackWriter] = [:]
    private var failure: String?
    let onFault: (String, String) -> Void

    init(onFault: @escaping (String, String) -> Void) { self.onFault = onFault }

    func prepare(track: String, directory: URL, sessionID: String, format: PCMFormat, origin: UInt64,
                 subchunkMS: Int, progress: @escaping ([String: Any]) -> Void) throws {
        try queue.sync {
            writers[track] = try TrackWriter(directory: directory, sessionID: sessionID, track: track,
                format: format, origin: origin, subchunkMS: subchunkMS, progress: progress)
        }
    }

    func markRecording() throws { try queue.sync { for writer in writers.values { try writer.markRecording() } } }

    func submit(track: String, format: PCMFormat, data: Data, tick: UInt64) {
        lock.lock()
        guard accepting else { lock.unlock(); return }
        guard pendingBytes + data.count <= maxPendingBytes else {
            accepting = false; lock.unlock()
            fault(track, "Archive writer fell behind; capture stopped instead of dropping unreported audio")
            return
        }
        pendingBytes += data.count
        lock.unlock()
        queue.async {
            defer { self.lock.lock(); self.pendingBytes -= data.count; self.lock.unlock() }
            guard !self.failed, let writer = self.writers[track] else { return }
            do {
                guard writer.format == format else { throw HelperFailure("format_changed", "Capture format changed; start a new session") }
                let frames = data.count / format.blockAlign
                let position = self.positions[track, default: 0]
                self.positions[track] = position + frames
                if self.paused { self.discarded[track, default: 0] += frames; return }
                let expected = self.expectedTicks[track]
                let discontinuity = expected.map { abs(Double(tick) - Double($0)) > HostClock.frequency * 0.03 } ?? false
                if discontinuity {
                    try writer.seal()
                    try writer.hole("discontinuity", tick: tick)
                }
                self.expectedTicks[track] = HostClock.advance(tick, frames: frames, rate: format.rate)
                try writer.write(data, frames: frames, tick: tick, devicePosition: position, discontinuity: discontinuity)
            } catch { self.failOnQueue(track, "\(error)") }
        }
    }

    func fault(_ track: String, _ message: String) { queue.async { self.failOnQueue(track, message) } }

    private func failOnQueue(_ track: String, _ message: String) {
        guard !failed else { return }
        failed = true; failure = message
        lock.lock(); accepting = false; lock.unlock()
        onFault(track, message)
    }

    func setPaused(_ value: Bool, tick: UInt64) throws {
        try queue.sync {
            guard !failed else { throw HelperFailure("session_faulted", "Capture has faulted") }
            guard paused != value else { return }
            if value { pauseGeneration += 1 }
            for (track, writer) in writers {
                try writer.seal()
                try writer.hole(value ? "pause_begin" : "pause_end", tick: tick,
                    generation: pauseGeneration, discarded: discarded[track, default: 0])
            }
            paused = value; discarded = [:]; expectedTicks = [:]
        }
    }

    func finish(reason: String? = nil) -> [String: Any] {
        lock.lock(); accepting = false; lock.unlock()
        return queue.sync {
            var results: [String: Any] = [:]
            for (track, writer) in writers {
                do {
                    if paused { try writer.hole("pause_end", tick: HostClock.now(), generation: pauseGeneration, discarded: discarded[track, default: 0]) }
                    results[track] = try writer.finish(fault: failure ?? reason)
                } catch { results[track] = ["error": "\(error)"]; failure = "\(error)" }
            }
            results["sessionFaulted"] = failure != nil || reason != nil
            return results
        }
    }
}

final class CaptureSession: NSObject, SCStreamOutput, SCStreamDelegate {
    let sessionID: String
    let mode: String
    let origin = HostClock.now()
    private let emit: ([String: Any]) -> Void
    private var engine: AVAudioEngine?
    private var stream: SCStream?
    private var installedTap = false
    private var stopping = false
    private var finished = false
    private var starting = false
    private var stopRequested = false
    private var stopResult: [String: Any]?
    private var configurationObserver: NSObjectProtocol?
    private let callbackQueue = DispatchQueue(label: "audio-capture.screencapturekit", qos: .userInitiated)
    private lazy var sink = ArchiveSink { [weak self] track, message in
        guard let self = self else { return }
        self.progress(track, "session_fault", ["code": "capture_failed", "message": message])
        DispatchQueue.main.async { Task { _ = await self.stop(reason: message) } }
    }

    init(sessionID: String, mode: String, emit: @escaping ([String: Any]) -> Void) {
        self.sessionID = sessionID; self.mode = mode; self.emit = emit
    }

    private func progress(_ track: String, _ event: String, _ detail: [String: Any]) {
        emit(["type": "progress", "session_id": sessionID, "track": track, "event": event, "detail": detail])
    }

    private func checkActive() throws {
        if stopping || stopRequested { throw HelperFailure("start_cancelled", "Capture startup was cancelled") }
    }

    func start(root: URL, command: [String: Any]) async throws -> [String: Any] {
        starting = true
        defer { starting = false }
        // System-only must not query/request mic permission or instantiate an input engine.
        if mode != "system" {
            let status = AVCaptureDevice.authorizationStatus(for: .audio)
            if status == .notDetermined {
                AVCaptureDevice.requestAccess(for: .audio) { _ in }
                throw HelperFailure("microphone_permission_required", "Grant Microphone access, then retry recording")
            }
            guard status == .authorized else { throw HelperFailure("microphone_permission_denied", "Microphone access is denied or restricted") }
        }
        if mode != "microphone", !CGPreflightScreenCaptureAccess() {
            DispatchQueue.main.async { _ = CGRequestScreenCaptureAccess() }
            throw HelperFailure("screen_permission_required", "Grant Screen Recording access in System Settings, restart the app if requested, then retry")
        }
        let subchunkMS = (command["subchunk_ms"] as? Int) ?? 1000
        guard (100...10000).contains(subchunkMS) else { throw HelperFailure("invalid_subchunk", "subchunk_ms must be 100-10000") }
        var result: [String: Any] = ["started": true, "sessionId": sessionID, "captureMode": mode,
            "sessionOriginQpc": origin, "qpcFrequency": HostClock.frequency, "clockSource": "mach_absolute_time",
            "clockUnitNote": "Legacy qpc keys contain mach host ticks, not Windows QPC or IAudioClock", "archivePending": true]
        var microphoneDirectory: URL?
        if mode != "system" {
            let spec = command["microphone"] as? [String: Any] ?? (mode == "microphone" ? command : nil)
            guard let spec = spec, let output = spec["output_dir"] as? String else {
                throw HelperFailure("invalid_start", "Microphone output_dir is required")
            }
            let directory = try canonicalDirectory(output, root: root)
            microphoneDirectory = directory
            let info = try prepareMicrophone(directory: directory, spec: spec, subchunkMS: subchunkMS)
            result["microphone"] = info
            if mode == "microphone" { result.merge(info) { _, new in new } }
        }
        var systemDirectory: URL?
        if mode != "microphone" {
            let spec = command["system"] as? [String: Any] ?? (mode == "system" ? command : nil)
            guard let spec = spec, let output = spec["output_dir"] as? String else {
                throw HelperFailure("invalid_start", "System output_dir is required")
            }
            let directory = try canonicalDirectory(output, root: root)
            guard microphoneDirectory != directory else { throw HelperFailure("path_denied", "Track directories must differ") }
            systemDirectory = directory
            let content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: true)
            try checkActive()
            let selected = spec["device_id"] as? String
            let display = selected.flatMap { id in content.displays.first { "display:\($0.displayID)" == id } } ??
                (selected == nil || selected == "" || selected == "system-default" ? content.displays.first : nil)
            guard let display = display else { throw HelperFailure("display_not_found", "No authorized display is available for system audio capture") }
            let configuration = SCStreamConfiguration()
            configuration.capturesAudio = true
            configuration.excludesCurrentProcessAudio = false
            configuration.sampleRate = 48000
            configuration.channelCount = 2
            configuration.width = 2; configuration.height = 2
            configuration.minimumFrameInterval = CMTime(value: 1, timescale: 1)
            configuration.queueDepth = 3
            configuration.showsCursor = false
            let filter = SCContentFilter(display: display, excludingWindows: [])
            let capture = SCStream(filter: filter, configuration: configuration, delegate: self)
            // Discard video callbacks immediately; only audio enters the archive.
            try capture.addStreamOutput(self, type: .screen, sampleHandlerQueue: callbackQueue)
            try capture.addStreamOutput(self, type: .audio, sampleHandlerQueue: callbackQueue)
            stream = capture
            result["system"] = ["track": "system", "role": "remote_mix_for_diarization",
                "deviceId": "display:\(display.displayID)", "deviceName": "System audio (ScreenCaptureKit)",
                "outputDir": directory.path, "actualL0Format": PCMFormat(rate: 48000, channels: 2).json,
                "captureScope": "screencapturekit_display_mix", "processIsolation": false,
                "notes": ["not an output-endpoint loopback", "includes app playback", "protected content may be silent", "video is discarded"]]
        }
        try checkActive()
        if let directory = systemDirectory {
            try sink.prepare(track: "system", directory: directory, sessionID: sessionID,
                format: PCMFormat(rate: 48000, channels: 2), origin: origin, subchunkMS: subchunkMS) { [weak self] entry in self?.progress("system", "subchunk_sealed", entry) }
        }
        try sink.markRecording()
        if let engine = engine {
            engine.prepare()
            try engine.start()
        }
        if let stream = stream { try await stream.startCapture() }
        try checkActive()
        if mode == "system", let info = result["system"] as? [String: Any] { result.merge(info) { _, new in new } }
        return result
    }

    private func prepareMicrophone(directory: URL, spec: [String: Any], subchunkMS: Int) throws -> [String: Any] {
        let engine = AVAudioEngine()
        self.engine = engine
        let input = engine.inputNode
        if let idText = spec["device_id"] as? String, !idText.isEmpty {
            guard var deviceID = AudioDeviceID(idText), microphoneDevices().contains(where: { $0["id"] as? String == idText }),
                  let unit = input.audioUnit else { throw HelperFailure("device_not_found", "Selected microphone is not available") }
            guard AudioUnitSetProperty(unit, kAudioOutputUnitProperty_CurrentDevice, kAudioUnitScope_Global,
                0, &deviceID, UInt32(MemoryLayout<AudioDeviceID>.size)) == noErr else {
                throw HelperFailure("device_select_failed", "Could not select the microphone")
            }
        }
        let nativeFormat = input.outputFormat(forBus: 0)
        let micFormat = try PCMFormat(nativeFormat)
        try sink.prepare(track: "microphone", directory: directory, sessionID: sessionID,
            format: micFormat, origin: origin, subchunkMS: subchunkMS) { [weak self] entry in self?.progress("microphone", "subchunk_sealed", entry) }
        input.installTap(onBus: 0, bufferSize: 2048, format: nativeFormat) { [weak self] buffer, time in
            guard let self = self else { return }
            do {
                let (format, data) = try interleavedPCM(buffer)
                guard time.isHostTimeValid else { throw HelperFailure("timestamp_invalid", "Microphone has no host timestamp") }
                self.sink.submit(track: "microphone", format: format, data: data, tick: time.hostTime)
            } catch { self.sink.fault("microphone", "\(error)") }
        }
        installedTap = true
        configurationObserver = NotificationCenter.default.addObserver(forName: .AVAudioEngineConfigurationChange,
            object: engine, queue: nil) { [weak self] _ in
                self?.sink.fault("microphone", "Audio device configuration changed; recording stopped to preserve format integrity")
            }
        return ["track": "microphone", "role": "self", "outputDir": directory.path,
            "deviceId": spec["device_id"] as? String ?? "default", "actualL0Format": micFormat.json, "captureScope": "microphone"]
    }

    func pause(_ value: Bool) throws -> [String: Any] {
        try checkActive()
        let tick = HostClock.now()
        try sink.setPaused(value, tick: tick)
        return ["paused": value, "holeQpc": tick, "clockSource": "mach_absolute_time"]
    }

    func stop(reason: String? = nil) async -> [String: Any] {
        if finished { return stopResult ?? ["stopped": true, "idempotent": true] }
        if starting {
            stopRequested = true
            while starting { try? await Task.sleep(nanoseconds: 10_000_000) }
            return await stop(reason: reason)
        }
        if stopping {
            while !finished { try? await Task.sleep(nanoseconds: 10_000_000) }
            return stopResult ?? ["stopped": true, "idempotent": true]
        }
        stopping = true
        if let observer = configurationObserver { NotificationCenter.default.removeObserver(observer); configurationObserver = nil }
        engine?.stop()
        if installedTap { engine?.inputNode.removeTap(onBus: 0); installedTap = false }
        engine = nil
        var finalReason = reason
        if let capture = stream {
            do { try await capture.stopCapture() } catch { if finalReason == nil { finalReason = "ScreenCaptureKit stop failed: \(error)" } }
            stream = nil
        }
        // stopCapture completion plus this barrier drains callbacks before sealing the tail.
        callbackQueue.sync {}
        var result = sink.finish(reason: finalReason)
        result["stopped"] = true; result["captureMode"] = mode
        stopResult = result; finished = true
        return result
    }

    func stream(_ stream: SCStream, didStopWithError error: Error) {
        sink.fault("system", "ScreenCaptureKit stopped: \(error)")
    }

    func stream(_ stream: SCStream, didOutputSampleBuffer sampleBuffer: CMSampleBuffer, of type: SCStreamOutputType) {
        guard type == .audio, CMSampleBufferDataIsReady(sampleBuffer) else { return }
        let count = CMSampleBufferGetNumSamples(sampleBuffer)
        guard count > 0 else { return }
        guard count <= 65536, let description = CMSampleBufferGetFormatDescription(sampleBuffer) else {
            sink.fault("system", "Invalid or oversized system audio packet"); return
        }
        let format = AVAudioFormat(cmAudioFormatDescription: description)
        guard let pcm = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: AVAudioFrameCount(count)) else {
            sink.fault("system", "Could not allocate audio callback buffer"); return
        }
        pcm.frameLength = AVAudioFrameCount(count)
        let status = CMSampleBufferCopyPCMDataIntoAudioBufferList(sampleBuffer, at: 0, frameCount: Int32(count), into: pcm.mutableAudioBufferList)
        guard status == noErr else { sink.fault("system", "Could not copy ScreenCaptureKit PCM (\(status))"); return }
        do {
            let (encoding, data) = try interleavedPCM(pcm)
            let pts = CMSampleBufferGetPresentationTimeStamp(sampleBuffer)
            guard pts.isValid, pts.isNumeric else { throw HelperFailure("timestamp_invalid", "System audio has no host timestamp") }
            sink.submit(track: "system", format: encoding, data: data, tick: CMClockConvertHostTimeToSystemUnits(pts))
        } catch { sink.fault("system", "\(error)") }
    }
}
