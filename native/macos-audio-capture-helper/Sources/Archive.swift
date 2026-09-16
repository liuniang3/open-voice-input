import Foundation
import Darwin
import AVFoundation

struct HelperFailure: Error {
    let code: String
    let message: String
    init(_ code: String, _ message: String) { self.code = code; self.message = message }
}

func nowMS() -> Int64 { Int64(Date().timeIntervalSince1970 * 1000) }

struct HostClock {
    static let frequency: Double = {
        var info = mach_timebase_info_data_t()
        mach_timebase_info(&info)
        return 1_000_000_000 * Double(info.denom) / Double(info.numer)
    }()
    static func now() -> UInt64 { mach_absolute_time() }
    static func advance(_ tick: UInt64, frames: Int, rate: Double) -> UInt64 {
        tick + UInt64((Double(frames) * frequency / rate).rounded())
    }
}

func jsonData(_ object: [String: Any]) throws -> Data {
    var data = try JSONSerialization.data(withJSONObject: object, options: [.sortedKeys])
    data.append(0x0a)
    return data
}

func ioError(_ operation: String) -> HelperFailure {
    HelperFailure("archive_io_failed", "\(operation) failed (errno \(errno))")
}

func syncFile(_ file: FileHandle) throws {
    guard fsync(file.fileDescriptor) == 0 else { throw ioError("fsync") }
    // F_FULLFSYNC requests hardware-cache flush on supported local filesystems.
    _ = fcntl(file.fileDescriptor, F_FULLFSYNC)
}

func syncDirectory(_ directory: URL) throws {
    let fd = Darwin.open(directory.path, O_RDONLY | O_DIRECTORY)
    guard fd >= 0 else { throw ioError("open directory") }
    defer { Darwin.close(fd) }
    guard fsync(fd) == 0 else { throw ioError("fsync directory") }
}

func exclusiveFile(_ url: URL) throws -> FileHandle {
    let fd = Darwin.open(url.path, O_CREAT | O_EXCL | O_WRONLY | O_NOFOLLOW, S_IRUSR | S_IWUSR)
    guard fd >= 0 else { throw ioError("create exclusive archive file") }
    return FileHandle(fileDescriptor: fd, closeOnDealloc: true)
}

func appendJSON(_ url: URL, _ value: [String: Any]) throws {
    let fd = Darwin.open(url.path, O_CREAT | O_APPEND | O_WRONLY | O_NOFOLLOW, S_IRUSR | S_IWUSR)
    guard fd >= 0 else { throw ioError("open journal") }
    let file = FileHandle(fileDescriptor: fd, closeOnDealloc: true)
    defer { try? file.close() }
    try file.write(contentsOf: jsonData(value))
    try syncFile(file)
}

func canonicalDirectory(_ value: String, root: URL? = nil) throws -> URL {
    guard !value.isEmpty, !value.contains("\0"),
          !value.replacingOccurrences(of: "\\", with: "/").split(separator: "/").contains("..") else {
        throw HelperFailure("path_denied", "Directory is empty or contains parent traversal")
    }
    let candidate: URL
    if value.hasPrefix("/") { candidate = URL(fileURLWithPath: value, isDirectory: true) }
    else if let root = root { candidate = root.appendingPathComponent(value, isDirectory: true) }
    else { throw HelperFailure("path_denied", "Session root must be absolute") }
    let resolved = candidate.standardizedFileURL.resolvingSymlinksInPath()
    func check(_ url: URL) throws {
        if let root = root {
            let prefix = root.path.hasSuffix("/") ? root.path : root.path + "/"
            guard url.path == root.path || url.path.hasPrefix(prefix) else {
                throw HelperFailure("path_denied", "Output directory escapes the configured session root")
            }
        }
    }
    try check(resolved)
    try FileManager.default.createDirectory(at: resolved, withIntermediateDirectories: true)
    let actual = resolved.resolvingSymlinksInPath()
    try check(actual)
    return actual
}

struct PCMFormat: Equatable {
    let rate: Double
    let channels: Int
    var blockAlign: Int { channels * 4 }
    var json: [String: Any] {
        ["sampleRate": rate, "channels": channels, "bitsPerSample": 32,
         "blockAlign": blockAlign, "formatTag": 3, "subFormat": "WAVE_FORMAT_IEEE_FLOAT",
         "layer": "L0", "interleaved": true,
         "note": "Source PCM float32; planar channels interleaved without resampling or mixing"]
    }
    init(_ format: AVAudioFormat) throws {
        guard format.commonFormat == .pcmFormatFloat32, format.sampleRate > 0,
              format.sampleRate.isFinite, format.channelCount > 0, format.channelCount <= 32 else {
            throw HelperFailure("format_unsupported", "Capture requires valid float32 PCM (1-32 channels)")
        }
        rate = format.sampleRate; channels = Int(format.channelCount)
    }
    init(rate: Double, channels: Int) { self.rate = rate; self.channels = channels }
}

// Copies borrowed tap memory before the callback returns. No audio is held for the full session.
func interleavedPCM(_ buffer: AVAudioPCMBuffer) throws -> (PCMFormat, Data) {
    let format = try PCMFormat(buffer.format)
    let frames = Int(buffer.frameLength)
    guard let channels = buffer.floatChannelData, frames > 0 else {
        throw HelperFailure("buffer_invalid", "Audio callback supplied an empty PCM buffer")
    }
    if buffer.format.isInterleaved {
        return (format, Data(bytes: channels[0], count: frames * format.blockAlign))
    }
    var data = Data(count: frames * format.blockAlign)
    data.withUnsafeMutableBytes { raw in
        let target = raw.bindMemory(to: Float.self)
        for frame in 0..<frames {
            for channel in 0..<format.channels { target[frame * format.channels + channel] = channels[channel][frame] }
        }
    }
    return (format, data)
}

final class TrackWriter {
    let directory: URL
    let sessionID: String
    let track: String
    let role: String
    let format: PCMFormat
    let origin: UInt64
    let chunkFrames: Int
    let progress: ([String: Any]) -> Void
    private var file: FileHandle?
    private var sequence = 0
    private var partFrames = 0
    private var totalFrames = 0
    private var startTick: UInt64 = 0
    private var endTick: UInt64 = 0
    private var deviceStart = 0
    private var deviceEnd = 0
    private var discontinuities = 0
    private var state = "preparing"

    init(directory: URL, sessionID: String, track: String, format: PCMFormat,
         origin: UInt64, subchunkMS: Int, progress: @escaping ([String: Any]) -> Void) throws {
        self.directory = directory; self.sessionID = sessionID; self.track = track
        self.role = track == "microphone" ? "self" : "remote_mix_for_diarization"
        self.format = format; self.origin = origin; self.progress = progress
        chunkFrames = max(1, Int(format.rate * Double(subchunkMS) / 1000))
        guard try FileManager.default.contentsOfDirectory(atPath: directory.path).isEmpty else {
            throw HelperFailure("archive_exists", "Track directory is not empty; create a new session to preserve recordings")
        }
        let owner = try exclusiveFile(directory.appendingPathComponent(".capture-owner"))
        try owner.write(contentsOf: Data(sessionID.utf8)); try syncFile(owner); try owner.close()
        try manifest()
        try journal("open", ["track": track, "state": state])
    }

    func markRecording() throws { state = "recording"; try manifest() }

    func journal(_ kind: String, _ detail: [String: Any]) throws {
        try appendJSON(directory.appendingPathComponent("journal.jsonl"), ["t": nowMS(), "kind": kind, "detail": detail])
    }

    func hole(_ reason: String, tick: UInt64, generation: Int = 0, discarded: Int = 0) throws {
        try journal("hole", ["reason": reason, "track": track, "role": role,
            "detail": ["holeQpc": tick, "sessionOriginQpc": origin, "qpcFrequency": HostClock.frequency,
                       "clockSource": "mach_absolute_time", "pauseGen": generation, "discardedFrames": discarded]])
    }

    func write(_ data: Data, frames: Int, tick: UInt64, devicePosition: Int, discontinuity: Bool) throws {
        guard data.count == frames * format.blockAlign else { throw HelperFailure("frame_alignment", "PCM is not frame aligned") }
        var consumed = 0
        while consumed < frames {
            if file == nil { file = try exclusiveFile(directory.appendingPathComponent("current.part")) }
            let take = min(frames - consumed, chunkFrames - partFrames)
            let segmentTick = HostClock.advance(tick, frames: consumed, rate: format.rate)
            if partFrames == 0 { startTick = segmentTick; deviceStart = devicePosition + consumed }
            endTick = HostClock.advance(segmentTick, frames: take, rate: format.rate)
            deviceEnd = devicePosition + consumed + take
            if consumed == 0 && discontinuity { discontinuities += 1 }
            let begin = consumed * format.blockAlign
            try file?.write(contentsOf: data.subdata(in: begin..<(begin + take * format.blockAlign)))
            consumed += take; partFrames += take; totalFrames += take
            if partFrames == chunkFrames { try seal() }
        }
    }

    func seal() throws {
        guard let current = file, partFrames > 0 else { return }
        try syncFile(current)
        try current.close()
        file = nil
        let seq = sequence + 1
        let name = String(format: "%06d.l0.pcm", seq)
        let destination = directory.appendingPathComponent(name)
        guard !FileManager.default.fileExists(atPath: destination.path) else { throw HelperFailure("archive_exists", "Refusing to replace committed PCM") }
        try FileManager.default.moveItem(at: directory.appendingPathComponent("current.part"), to: destination)
        try syncDirectory(directory)
        let entry: [String: Any] = ["schema": "l0_chunk_v1", "seq": seq, "file": name,
            "bytes": partFrames * format.blockAlign, "frames": partFrames,
            "frameStart": totalFrames - partFrames, "frameEnd": totalFrames,
            "devicePosStart": deviceStart, "devicePosEnd": deviceEnd,
            "clockPosStart": startTick, "clockPosEnd": endTick,
            "qpcStart": startTick, "qpcEnd": endTick, "sessionOriginQpc": origin,
            "sessionStartMs": (Double(startTick) - Double(origin)) * 1000 / HostClock.frequency,
            "sessionEndMs": (Double(endTick) - Double(origin)) * 1000 / HostClock.frequency,
            "qpcFrequency": HostClock.frequency, "clockFrequency": HostClock.frequency,
            "clockSource": "mach_absolute_time", "clockQpcPointSample": false,
            "timingNote": "qpc keys are compatibility aliases for mach host ticks; packet PTS plus frame offsets; devicePos counts source frames, not IAudioClock",
            "silentFrames": 0, "discontinuityCount": discontinuities,
            "track": track, "role": role, "format": format.json, "committedAt": nowMS()]
        // Publish index only after PCM rename and directory sync. Recovery can scan orphan PCM.
        try appendJSON(directory.appendingPathComponent("index.jsonl"), entry)
        try journal("commit", entry)
        sequence = seq; partFrames = 0; discontinuities = 0
        try manifest()
        progress(entry)
    }

    func finish(fault: String? = nil) throws -> [String: Any] {
        if state == "finished" || state == "faulted" { return summary }
        try seal()
        state = fault == nil ? "finished" : "faulted"
        try manifest()
        try journal(fault == nil ? "finish" : "fault", ["state": state, "totalFrames": totalFrames, "reason": fault ?? "stop"])
        return summary
    }

    var summary: [String: Any] {
        ["seq": sequence, "track": track, "role": role, "trackDir": directory.path,
         "totalFrames": totalFrames, "state": state, "recording": state == "recording",
         "archivePending": true, "actualL0Format": format.json]
    }

    private func manifest() throws {
        var value = summary
        value["sessionId"] = sessionID; value["schema"] = "l0_track_manifest_v1"
        value["sessionOriginQpc"] = origin; value["qpcFrequency"] = HostClock.frequency
        value["clockSource"] = "mach_absolute_time"
        let temporary = directory.appendingPathComponent("manifest.\(UUID().uuidString).tmp")
        let handle = try exclusiveFile(temporary)
        try handle.write(contentsOf: jsonData(value)); try syncFile(handle); try handle.close()
        guard Darwin.rename(temporary.path, directory.appendingPathComponent("manifest.json").path) == 0 else { throw ioError("rename manifest") }
        try syncDirectory(directory)
    }
}
