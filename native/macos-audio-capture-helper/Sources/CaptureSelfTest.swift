import Foundation

// Synthetic system PCM exercises the same sink as ScreenCaptureKit without permissions/devices.
func systemPauseArchiveSelfTest(directory: URL) throws -> [String: Any] {
    let sink = ArchiveSink { _, message in
        Wire.send(["type": "error", "code": "self_test_failed", "message": message])
    }
    let now = HostClock.now()
    let oneSecond = UInt64(HostClock.frequency)
    let origin = now > oneSecond ? now - oneSecond : 0
    let format = PCMFormat(rate: 1000, channels: 1)
    try sink.prepare(track: "system", directory: directory, sessionID: "system-pause-test",
        format: format, origin: origin, subchunkMS: 100, progress: { _ in })
    try sink.markRecording()
    func submit(_ frames: Int, _ value: Float, _ offset: Int) {
        let samples = [Float](repeating: value, count: frames)
        let data = samples.withUnsafeBytes { Data($0) }
        sink.submit(track: "system", format: format, data: data,
            tick: HostClock.advance(origin, frames: offset, rate: 1000))
    }
    submit(25, 0.25, 0)
    try sink.setPaused(true, tick: HostClock.advance(origin, frames: 25, rate: 1000))
    try sink.setPaused(true, tick: HostClock.advance(origin, frames: 25, rate: 1000))
    submit(50, 0.75, 25)
    try sink.setPaused(false, tick: HostClock.advance(origin, frames: 75, rate: 1000))
    submit(175, 0.5, 75)
    // Also close a pause on stop without changing any committed PCM.
    try sink.setPaused(true, tick: HostClock.advance(origin, frames: 250, rate: 1000))
    return sink.finish()
}
