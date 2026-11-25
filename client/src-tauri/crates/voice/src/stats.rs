//! Connection and audio-pipeline statistics for diagnostics.
//!
//! Network numbers come from libwebrtc's RTC stats (`Room::get_stats`); the
//! pipeline counters come from the audio threads and distinguish sample loss
//! from distortion (stage 2.3.1). Nothing here is shown in a separate UI panel:
//! the values travel with [`crate::VoiceEvent::Stats`] and are logged.

use serde::{Deserialize, Serialize};

use livekit::rtc_engine::SessionStats;
use livekit::webrtc::stats::RtcStats;

/// Counters maintained by the audio threads since the pipeline started.
///
/// Every counter is monotonic; the engine reports deltas between snapshots.
/// A non-zero value is a defect worth investigating, not a normal event:
/// - `capture_underruns` — the capture path produced no samples at all for a
///   10 ms frame (the device is dead or gone); a frame that was only partly
///   filled is a different defect and has its own counter;
/// - `partial_capture_frames` — the capture path filled only part of a 10 ms
///   frame (`0 < written < 480`): the rest of the frame is silence, which is
///   audible as a click in the middle of a word (stage 2.3.2a). These frames
///   used to be added to `capture_underruns`; they no longer are;
/// - `input_overflows` — the capture callback found the input ring full and
///   dropped a sample;
/// - `resampler_overflows` — the resampler's one-second buffer was full and the
///   oldest sample was dropped;
/// - `publish_overflows` — the publish ring was full, or the publisher drained
///   a backlog that would otherwise grow the latency;
/// - `publish_underruns` — the publisher went 100 ms without a whole frame;
/// - `playback_underruns` — the output callback found no sample and played
///   silence (device-side gap);
/// - `mixer_underruns` — a remote track delivered less than a full mixer frame
///   (including a completely empty one);
/// - `track_trims` — a receive ring ran ahead of the output clock and frames
///   were dropped to keep the latency bounded (stage 2.3.2c);
/// - `reference_trims` — the AEC reference ring fell behind the capture path by
///   more than 100 ms and was cut back to 30 ms;
/// - `apm_errors` — `AudioProcessingModule` rejected a 10 ms frame.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct AudioCounters {
    /// Completely empty capture frames (`written == 0`); partial frames are
    /// counted by `partial_capture_frames`, not here.
    pub capture_underruns: u64,
    /// Frames the capture path filled only partially (`0 < written < 480`).
    pub partial_capture_frames: u64,
    pub input_overflows: u64,
    pub resampler_overflows: u64,
    pub publish_overflows: u64,
    pub publish_underruns: u64,
    pub playback_underruns: u64,
    pub mixer_underruns: u64,
    /// Bounded trims of receive rings that ran ahead of the output clock.
    pub track_trims: u64,
    /// Times the AEC reference ring was cut back to its 30 ms reserve.
    pub reference_trims: u64,
    pub apm_errors: u64,
}

impl AudioCounters {
    /// True when at least one counter is non-zero.
    #[must_use]
    pub fn any(&self) -> bool {
        self != &Self::default()
    }

    /// One-line summary for logs; contains no user data.
    #[must_use]
    pub fn summary(&self) -> String {
        format!(
            "capture_underruns={} partial_capture_frames={} input_overflows={} \
             resampler_overflows={} publish_overflows={} publish_underruns={} \
             playback_underruns={} mixer_underruns={} track_trims={} \
             reference_trims={} apm_errors={}",
            self.capture_underruns,
            self.partial_capture_frames,
            self.input_overflows,
            self.resampler_overflows,
            self.publish_overflows,
            self.publish_underruns,
            self.playback_underruns,
            self.mixer_underruns,
            self.track_trims,
            self.reference_trims,
            self.apm_errors
        )
    }
}

/// One statistics snapshot shown by the connection indicator.
#[derive(Debug, Clone, Copy, Default, PartialEq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct VoiceStats {
    /// Round-trip time of the selected ICE pair, milliseconds.
    pub ping_ms: Option<f32>,
    /// Lost inbound RTP packets, percent of all expected audio packets.
    pub packet_loss_percent: Option<f32>,
    /// Mean inbound RTP jitter, milliseconds.
    pub jitter_ms: Option<f32>,
    /// Audio-pipeline counters since the snapshot baseline.
    pub audio: AudioCounters,
}

impl VoiceStats {
    /// Playback gaps since start, kept for the quality indicator.
    #[must_use]
    pub fn playback_underruns(&self) -> u64 {
        self.audio.playback_underruns
    }
}

/// Turns raw libwebrtc statistics into [`VoiceStats`].
#[derive(Debug, Default)]
pub struct StatsCollector {
    last: VoiceStats,
}

impl StatsCollector {
    /// Converts a libwebrtc snapshot. `counters` are the engine counters.
    pub fn update(&mut self, stats: &SessionStats, counters: AudioCounters) -> VoiceStats {
        let mut received = 0u64;
        let mut lost = 0u64;
        let mut jitter_sum = 0.0f64;
        let mut jitter_count = 0u32;

        for entry in &stats.subscriber_stats {
            if let RtcStats::InboundRtp(inbound) = entry {
                if !inbound.stream.kind.is_empty() && inbound.stream.kind != "audio" {
                    continue;
                }
                received = received.saturating_add(inbound.received.packets_received);
                // `packets_lost` is signed in the spec; a negative value is a
                // duplicate-count correction, not loss.
                lost = lost.saturating_add(inbound.received.packets_lost.max(0) as u64);
                if inbound.received.jitter >= 0.0 {
                    jitter_sum += inbound.received.jitter;
                    jitter_count += 1;
                }
            }
        }

        let total = received.saturating_add(lost);
        let packet_loss_percent = (total > 0).then(|| (lost as f32 / total as f32) * 100.0);

        let mut ping: Option<f32> = None;
        for entry in stats.subscriber_stats.iter().chain(&stats.publisher_stats) {
            if let RtcStats::CandidatePair(pair) = entry {
                if !pair.candidate_pair.nominated && pair.candidate_pair.state.is_some() {
                    continue;
                }
                let rtt = pair.candidate_pair.current_round_trip_time;
                if rtt > 0.0 {
                    let ms = (rtt * 1_000.0) as f32;
                    ping = Some(ping.map_or(ms, |current: f32| current.min(ms)));
                }
            }
        }

        let jitter_ms =
            (jitter_count > 0).then(|| ((jitter_sum / f64::from(jitter_count)) * 1_000.0) as f32);

        let snapshot = VoiceStats {
            ping_ms: ping,
            packet_loss_percent,
            jitter_ms,
            audio: counters,
        };
        self.last = snapshot;
        snapshot
    }

    /// Last snapshot.
    #[must_use]
    pub fn last(&self) -> VoiceStats {
        self.last
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use livekit::webrtc::stats::{dictionaries, CandidatePairStats, InboundRtpStats};

    fn inbound(received: u64, lost: i64, jitter: f64) -> RtcStats {
        RtcStats::InboundRtp(InboundRtpStats {
            stream: dictionaries::RtpStreamStats {
                kind: "audio".to_owned(),
                ..Default::default()
            },
            received: dictionaries::ReceivedRtpStreamStats {
                packets_received: received,
                packets_lost: lost,
                jitter,
            },
            ..Default::default()
        })
    }

    fn pair(rtt: f64) -> RtcStats {
        RtcStats::CandidatePair(CandidatePairStats {
            candidate_pair: dictionaries::CandidatePairStats {
                nominated: true,
                current_round_trip_time: rtt,
                ..Default::default()
            },
            ..Default::default()
        })
    }

    fn counters() -> AudioCounters {
        AudioCounters {
            capture_underruns: 1,
            partial_capture_frames: 9,
            input_overflows: 2,
            resampler_overflows: 3,
            publish_overflows: 4,
            publish_underruns: 5,
            playback_underruns: 6,
            mixer_underruns: 7,
            track_trims: 8,
            reference_trims: 9,
            apm_errors: 10,
        }
    }

    #[test]
    fn converts_loss_jitter_ping_and_counters() {
        let stats = SessionStats {
            publisher_stats: vec![pair(0.070)],
            subscriber_stats: vec![inbound(990, 10, 0.020), inbound(0, 0, 0.040)],
        };
        let mut collector = StatsCollector::default();
        let snapshot = collector.update(&stats, counters());
        assert!((snapshot.packet_loss_percent.unwrap() - 1.0).abs() < 0.01);
        assert!((snapshot.jitter_ms.unwrap() - 30.0).abs() < 0.01);
        assert!((snapshot.ping_ms.unwrap() - 70.0).abs() < 0.01);
        assert_eq!(snapshot.audio, counters());
        assert_eq!(snapshot.playback_underruns(), 6);
    }

    #[test]
    fn empty_stats_produce_no_guesses() {
        let mut collector = StatsCollector::default();
        let snapshot = collector.update(
            &SessionStats {
                publisher_stats: Vec::new(),
                subscriber_stats: Vec::new(),
            },
            AudioCounters::default(),
        );
        assert_eq!(snapshot, VoiceStats::default());
        assert!(!snapshot.audio.any());
    }

    #[test]
    fn negative_packet_loss_is_ignored() {
        let stats = SessionStats {
            publisher_stats: Vec::new(),
            subscriber_stats: vec![inbound(100, -3, 0.0)],
        };
        let mut collector = StatsCollector::default();
        assert_eq!(
            collector
                .update(&stats, AudioCounters::default())
                .packet_loss_percent,
            Some(0.0)
        );
    }

    #[test]
    fn picks_the_lowest_positive_rtt() {
        let stats = SessionStats {
            publisher_stats: vec![pair(0.120), pair(0.035)],
            subscriber_stats: Vec::new(),
        };
        let mut collector = StatsCollector::default();
        assert!(
            (collector
                .update(&stats, AudioCounters::default())
                .ping_ms
                .unwrap()
                - 35.0)
                .abs()
                < 0.01
        );
    }

    #[test]
    fn counter_summary_names_every_counter() {
        let summary = counters().summary();
        for name in [
            "capture_underruns",
            "partial_capture_frames",
            "input_overflows",
            "resampler_overflows",
            "publish_overflows",
            "publish_underruns",
            "playback_underruns",
            "mixer_underruns",
            "track_trims",
            "reference_trims",
            "apm_errors",
        ] {
            assert!(summary.contains(name), "missing {name} in {summary}");
        }
    }
}
