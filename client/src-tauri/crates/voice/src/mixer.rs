//! Per-participant receive mixer: volume, local mute and speaking detection.
//!
//! Every remote audio track owns a lock-free ring filled by its
//! `NativeAudioStream` task and drained by the playback thread. The mixer sums
//! the rings, applies the per-user volume (0..200 %) and local mute, and feeds
//! the result to the output device and to the AEC reference stream.

use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::Arc;

use ringbuf::traits::{Consumer, Observer, Producer, Split};
use ringbuf::{HeapCons, HeapProd, HeapRb};

use crate::frame::FRAME_SAMPLES;
use crate::level::{LevelSmoother, SpeakingDetector};
use crate::leveler::{Leveler, CEILING};

/// Ring capacity per participant: one second of 48 kHz audio.
const TRACK_CAPACITY: usize = 48_000;

/// Jitter reserve of a receive ring, three 10 ms frames (stage 2.3.2c).
///
/// The output device clocks the receive path: `playback_loop` mixes a frame
/// only when the speakers have taken one. The reserve lets the device take a
/// whole frame without the ring falling below one, so a track is never read
/// partially. It costs 30 ms of latency.
const TRACK_PRIME: usize = 3 * FRAME_SAMPLES;

/// Above 80 ms the ring is ahead of the output clock. One frame is dropped to
/// shed the drift — but only a quiet one, because dropping audio inside a word
/// is audible as a click and the ring still has plenty of room.
const TRACK_HIGH: usize = 8 * FRAME_SAMPLES;

/// Above 200 ms the backlog is no longer jitter: frames are dropped down to
/// [`TRACK_PRIME`] without looking at their level, because latency matters more
/// than a click at the boundary. This is the last resort, not the normal trim.
const TRACK_MAX: usize = 20 * FRAME_SAMPLES;

/// Peak amplitude of a "quiet" frame: −50 dBFS in 16-bit units
/// (`32_768 × 10^(−50/20) ≈ 104`). Lazily-dropped drift frames must stay below
/// it, so the drop is inaudible.
const QUIET_PEAK: u16 = 104;

/// Lower edge of the elastic read: 27.5 ms. Below it the reader consumes a few
/// samples fewer than a frame and repeats them, so a source that runs slower
/// than the speakers (`NetEQ` is fed by the network, not by the crystal) is
/// followed instead of draining the reserve and re-priming with a 30 ms hole.
const TRACK_LOW: usize = TRACK_PRIME - 120;
/// Largest slip of one frame: 16 samples, 3.3 %. The detectors stress ±1 %.
const MAX_SLIP: i32 = 16;
/// Level gain: samples of slip per sample of level error. A 1 % rate mismatch
/// settles 50 samples below [`TRACK_LOW`], well inside the reserve.
const SLIP_GAIN: f32 = 0.1;
/// Smoothing of the ring level. The producer pushes a whole frame at a time, so
/// the raw level sawtooths by a frame; the slip must follow the average.
const LEVEL_ALPHA: f32 = 0.1;

/// Shared live level of one participant, read by the reporter task.
#[derive(Debug)]
pub struct TrackLevel {
    identity: String,
    level_bits: AtomicU32,
    speaking: AtomicBool,
}

impl TrackLevel {
    fn new(identity: String) -> Self {
        Self {
            identity,
            level_bits: AtomicU32::new(f32::to_bits(crate::frame::SILENCE_DB)),
            speaking: AtomicBool::new(false),
        }
    }

    /// Participant identity as handed out by the media server.
    #[must_use]
    pub fn identity(&self) -> &str {
        &self.identity
    }

    /// Smoothed level in dBFS.
    #[must_use]
    pub fn level_db(&self) -> f32 {
        f32::from_bits(self.level_bits.load(Ordering::Relaxed))
    }

    /// True while the participant is speaking.
    #[must_use]
    pub fn is_speaking(&self) -> bool {
        self.speaking.load(Ordering::Relaxed)
    }
}

/// Producer side of one participant ring.
pub struct TrackPublisher {
    producer: HeapProd<i16>,
    dropped: u64,
}

impl TrackPublisher {
    /// Appends samples, dropping the newest ones if the ring is full.
    ///
    /// Called from the async receive task, never from the audio callback.
    pub fn push(&mut self, samples: &[i16]) {
        let mut remaining = samples;
        while !remaining.is_empty() {
            let written = self.producer.push_slice(remaining);
            if written == 0 {
                self.dropped = self.dropped.saturating_add(1);
                break;
            }
            remaining = &remaining[written..];
        }
    }

    /// Number of pushes that found the ring full.
    #[must_use]
    pub fn dropped(&self) -> u64 {
        self.dropped
    }
}

/// Reads whole 10 ms frames from a receive ring with a jitter reserve and a
/// bounded backlog (stage 2.3.2c).
///
/// Every participant track and the microphone-loop ring use it: the speakers
/// clock the receive path, so those rings are drained exactly as fast as the
/// device consumes and the drift between the remote clock and the output clock
/// has to be absorbed here, in bounded steps.
pub struct FrameReader {
    consumer: HeapCons<i16>,
    /// The ring has not yet held [`TRACK_PRIME`] since the last shortage.
    priming: bool,
    trims: u32,
    /// Smoothed ring level in samples, used by the elastic read.
    level: f32,
    /// Fractional slip carried between frames, in samples.
    slip: f32,
    /// Whether the reader may absorb a rate difference sample by sample.
    ///
    /// True for a remote track, whose source is not clocked by the output
    /// device. False for the microphone monitor: its two ends are the same
    /// engine, a timer skew there is tiny, and stretching the monitor would
    /// shift its pitch (the file-loop THD tests measure exactly that).
    elastic: bool,
    /// One frame plus the largest slip, allocated for the loop's lifetime.
    inbox: [i16; FRAME_SAMPLES + MAX_SLIP as usize],
}

impl FrameReader {
    /// Wraps a receive track. The first frame is read once the reserve is
    /// there, and the reader absorbs a slow source sample by sample.
    #[must_use]
    pub fn new(consumer: HeapCons<i16>) -> Self {
        Self::with_elastic(consumer, true)
    }

    /// Wraps a ring whose two ends run on the engine's own pacers (the
    /// microphone monitor, stage 2.3.2c): frame rules only.
    #[must_use]
    pub fn looped(consumer: HeapCons<i16>) -> Self {
        Self::with_elastic(consumer, false)
    }

    fn with_elastic(consumer: HeapCons<i16>, elastic: bool) -> Self {
        Self {
            consumer,
            priming: true,
            trims: 0,
            level: TRACK_PRIME as f32,
            slip: 0.0,
            elastic,
            inbox: [0; FRAME_SAMPLES + MAX_SLIP as usize],
        }
    }

    /// Reads exactly one whole frame into `out`.
    ///
    /// Returns false and fills `out` with silence when the ring holds less than
    /// a frame: a partial frame is never mixed with zeros, because that tail in
    /// the middle of a word is the click this stage removes. The track then
    /// re-primes and waits for the reserve again.
    ///
    /// When the ring sits below [`TRACK_LOW`] — the source is slower than the
    /// output device — the frame is built from a few input samples fewer and
    /// the difference is repeated inside the frame. Dropping or inserting a
    /// whole 10 ms frame there would be a hole, so the clock difference is
    /// absorbed sample by sample (stage 2.3.2c).
    pub fn read(&mut self, out: &mut [i16; FRAME_SAMPLES]) -> bool {
        if self.priming {
            let occupied = self.consumer.occupied_len();
            if occupied < TRACK_PRIME {
                out.fill(0);
                return false;
            }
            self.priming = false;
            self.level = occupied as f32;
        }
        self.shed_drift();
        let occupied = self.consumer.occupied_len();
        if occupied < FRAME_SAMPLES {
            out.fill(0);
            self.priming = true;
            return false;
        }
        self.level += LEVEL_ALPHA * (occupied as f32 - self.level);
        let slip = if self.elastic {
            self.slip_to_apply()
        } else {
            0
        };
        let wanted = (FRAME_SAMPLES as i32 + slip) as usize;
        let taken = self.consumer.pop_slice(&mut self.inbox[..wanted]);
        debug_assert_eq!(taken, wanted, "the ring was checked before the read");
        fit_frame(&self.inbox[..taken], out);
        true
    }

    /// Samples to consume fewer than a frame this time: zero inside the dead
    /// band, negative when the ring is running dry.
    fn slip_to_apply(&mut self) -> i32 {
        if self.level >= TRACK_LOW as f32 {
            self.slip = 0.0;
            return 0;
        }
        let error = self.level - TRACK_LOW as f32;
        self.slip += (error * SLIP_GAIN).clamp(-(MAX_SLIP as f32), 0.0);
        let whole = self.slip.floor();
        self.slip -= whole;
        whole as i32
    }

    /// Drops frames when the ring runs ahead of the output clock.
    fn shed_drift(&mut self) {
        let occupied = self.consumer.occupied_len();
        if occupied > TRACK_MAX {
            // Unconditional: a backlog past 200 ms is latency, not jitter.
            while self.consumer.occupied_len() > TRACK_PRIME {
                if self.consumer.skip(FRAME_SAMPLES) < FRAME_SAMPLES {
                    break;
                }
            }
            self.trims = self.trims.saturating_add(1);
            return;
        }
        if occupied > TRACK_HIGH {
            let mut oldest = [0i16; FRAME_SAMPLES];
            // Peek first: a frame is only dropped when it is quiet, so the
            // trim is inaudible. Loud speech waits for the hard limit instead.
            if self.consumer.peek_slice(&mut oldest) == FRAME_SAMPLES && is_quiet(&oldest) {
                let _ = self.consumer.skip(FRAME_SAMPLES);
            }
        }
    }

    /// Drift trims since the previous call; the pipeline reports them.
    pub fn take_trims(&mut self) -> u32 {
        std::mem::take(&mut self.trims)
    }
}

/// True when every sample of the frame is below −50 dBFS.
fn is_quiet(frame: &[i16; FRAME_SAMPLES]) -> bool {
    frame
        .iter()
        .all(|sample| sample.unsigned_abs() < QUIET_PEAK)
}

/// Fits `input` (one frame plus or minus a few samples) into exactly one frame
/// by nearest-neighbour stepping.
///
/// The step is uniform, so a missing sample is taken out of the middle of the
/// frame rather than at its edge: a one-sample step at 48 kHz is a fraction of
/// the waveform's own slope, while a whole-frame jump would be a click.
fn fit_frame(input: &[i16], out: &mut [i16; FRAME_SAMPLES]) {
    let count = input.len();
    debug_assert!(count > 0);
    let step = ((count as u64) << 16) / FRAME_SAMPLES as u64;
    let mut position = 0u64;
    for slot in out.iter_mut() {
        let index = ((position >> 16) as usize).min(count - 1);
        *slot = input[index];
        position += step;
    }
}

struct MixTrack {
    identity: String,
    reader: FrameReader,
    scratch: [i16; FRAME_SAMPLES],
    volume: f32,
    muted: bool,
    smoother: LevelSmoother,
    detector: SpeakingDetector,
    /// Loudness leveling of this voice (stage P17); state only, no buffers.
    leveler: Leveler,
    /// Incoming voice that may be leveled. Stream audio (music, game sound)
    /// lives in the same mixer but must keep its own dynamics (stage P25).
    level_audio: bool,
    level: Arc<TrackLevel>,
}

/// Final limiter recovery per block (about 0.2 s to unity).
const MIX_LIMITER_RELEASE: f32 = 0.05;

/// Peak limiter on the summed voice and stream tracks.
///
/// The per-track [`Leveler`] limits a voice at -1 dBFS *before* the user and
/// master gains, and the stream is not limited by the leveler at all. At 200 %
/// one full-scale track alone asks for +5 dBFS, and several voices exceed full
/// scale at 100 %. The mixer used to hard-clamp that sum, which is audible
/// distortion. This limiter stays at unity until the sum crosses -1 dBFS and
/// then scales the whole 10 ms block by the gain its own peak requires. The
/// block is already gathered here, so the peak is an exact look-ahead for the
/// frame: no sample needs a sample-by-sample clamp, the waveform keeps its
/// shape instead of a flat run at the rail, and the attack costs no latency.
/// Recovery towards unity is spread across the following blocks. A mix below
/// the ceiling is bit-identical, so an ordinary stream keeps its sound; event
/// cues are added after the mixer and are not touched at all (stage P25).
struct MixLimiter {
    /// Gain the previous block ended with.
    gain: f32,
}

impl MixLimiter {
    fn new() -> Self {
        Self { gain: 1.0 }
    }

    /// Scales the integer sum into `out`, never letting a sample pass the
    /// ceiling. The sum may exceed the 16-bit range; it is limited before the
    /// cast instead of being clamped sample by sample.
    fn process(&mut self, sum: &[i32], out: &mut [i16]) {
        let frames = sum.len().min(out.len());
        if frames == 0 {
            return;
        }
        let peak = sum[..frames]
            .iter()
            .map(|sample| (*sample as f32).abs() / 32_768.0)
            .fold(0.0f32, f32::max);
        // The largest gain that keeps this whole block under the ceiling. A
        // block is scaled as a unit, so the sample that reaches the peak is
        // never flattened: the samples around it keep their relative shape.
        let target = if peak > CEILING { CEILING / peak } else { 1.0 };
        // Move towards unity at the release rate, but never above what this
        // block allows: a new, louder block attacks at once instead of ramping
        // into the rail, while a quieter one recovers smoothly.
        let recovered = self.gain + (1.0 - self.gain) * MIX_LIMITER_RELEASE;
        let allowed = recovered.min(target);
        let (start, end) = if allowed <= self.gain {
            // Attack (or an unchanged gain): the new gain covers the block from
            // its first sample, which is what keeps every sample below the
            // ceiling without a clamp.
            (allowed, allowed)
        } else {
            (self.gain, allowed)
        };
        let step = if frames > 1 {
            (end - start) / (frames - 1) as f32
        } else {
            0.0
        };
        let limit = (CEILING * 32_768.0).floor();
        for (index, (sample, slot)) in sum[..frames]
            .iter()
            .zip(out[..frames].iter_mut())
            .enumerate()
        {
            // Computed from the index rather than accumulated, so the last
            // sample lands exactly on `end` and the ramp never drifts.
            let gain = start + step * index as f32;
            *slot = ((*sample as f32) * gain).round().clamp(-limit, limit) as i16;
        }
        self.gain = end;
    }
}

/// Sums all subscribed remote tracks into one output frame.
pub struct Mixer {
    tracks: Vec<MixTrack>,
    accumulator: [i32; FRAME_SAMPLES],
    /// Final safety limiter after all user and master gains (stage P25).
    limiter: MixLimiter,
    /// Master playback gain, 0..2 (0..200 %), multiplied with every track.
    master: f32,
    /// Whether incoming voices are leveled to a common loudness (P17).
    leveling: bool,
}

impl Default for Mixer {
    fn default() -> Self {
        Self::new()
    }
}

impl Mixer {
    /// Empty mixer.
    #[must_use]
    pub fn new() -> Self {
        Self {
            tracks: Vec::new(),
            accumulator: [0; FRAME_SAMPLES],
            limiter: MixLimiter::new(),
            master: 1.0,
            leveling: false,
        }
    }

    /// Creates a ring for a remote participant without touching the mixer.
    ///
    /// The controller creates the ring on its own thread and moves the
    /// consumer to the playback thread with [`Mixer::insert_track`]; the
    /// producer stays with the receive task.
    pub fn create_track(identity: &str) -> (TrackPublisher, Arc<TrackLevel>, HeapCons<i16>) {
        let ring = HeapRb::<i16>::new(TRACK_CAPACITY);
        let (producer, consumer) = ring.split();
        let level = Arc::new(TrackLevel::new(identity.to_owned()));
        (
            TrackPublisher {
                producer,
                dropped: 0,
            },
            level,
            consumer,
        )
    }

    /// Adds a prepared ring to the mixer.
    pub fn insert_track(
        &mut self,
        identity: &str,
        consumer: HeapCons<i16>,
        level: Arc<TrackLevel>,
    ) {
        self.insert_track_kind(identity, consumer, level, true);
    }

    /// Adds a screen-share audio ring: volume, mute and the meters apply, but
    /// the speech leveler must not touch music or game sound (stage P25).
    pub fn insert_stream_track(
        &mut self,
        identity: &str,
        consumer: HeapCons<i16>,
        level: Arc<TrackLevel>,
    ) {
        self.insert_track_kind(identity, consumer, level, false);
    }

    fn insert_track_kind(
        &mut self,
        identity: &str,
        consumer: HeapCons<i16>,
        level: Arc<TrackLevel>,
        level_audio: bool,
    ) {
        if let Some(index) = self.tracks.iter().position(|t| t.identity == identity) {
            self.tracks.remove(index);
        }
        self.tracks.push(MixTrack {
            identity: identity.to_owned(),
            reader: FrameReader::new(consumer),
            scratch: [0; FRAME_SAMPLES],
            volume: 1.0,
            muted: false,
            smoother: LevelSmoother::default(),
            detector: SpeakingDetector::default(),
            leveler: Leveler::new(),
            level_audio,
            level,
        });
    }

    /// Registers a remote participant. Returns the producer its audio stream
    /// writes to and the shared level handle.
    pub fn add_track(&mut self, identity: &str) -> (TrackPublisher, Arc<TrackLevel>) {
        let (publisher, level, consumer) = Self::create_track(identity);
        self.insert_track(identity, consumer, level.clone());
        (publisher, level)
    }

    /// Registers a screen-share audio stream. Volume, mute and the meters
    /// apply; loudness leveling does not (stage P25).
    pub fn add_stream_track(&mut self, identity: &str) -> (TrackPublisher, Arc<TrackLevel>) {
        let (publisher, level, consumer) = Self::create_track(identity);
        self.insert_stream_track(identity, consumer, level.clone());
        (publisher, level)
    }

    /// Removes a participant (left the room or unpublished).
    pub fn remove_track(&mut self, identity: &str) {
        self.tracks.retain(|track| track.identity != identity);
    }

    /// True when the participant is subscribed.
    #[must_use]
    pub fn has_track(&self, identity: &str) -> bool {
        self.tracks.iter().any(|track| track.identity == identity)
    }

    /// Sets the per-user gain, clamped to 0..200 %.
    pub fn set_volume(&mut self, identity: &str, volume: f32) {
        let volume = volume.clamp(0.0, 2.0);
        if let Some(track) = self.tracks.iter_mut().find(|t| t.identity == identity) {
            track.volume = volume;
        }
    }

    /// Sets the master playback gain, clamped to 0..200 %.
    pub fn set_master_volume(&mut self, volume: f32) {
        self.master = volume.clamp(0.0, 2.0);
    }

    /// Switches the loudness leveling of incoming voices (stage P17). Turning
    /// it off lets every track's gain glide back to unity instead of jumping.
    pub fn set_leveling(&mut self, enabled: bool) {
        self.leveling = enabled;
    }

    /// Locally mutes or unmutes a participant.
    pub fn set_muted(&mut self, identity: &str, muted: bool) {
        if let Some(track) = self.tracks.iter_mut().find(|t| t.identity == identity) {
            track.muted = muted;
        }
    }

    /// Number of subscribed participants.
    #[must_use]
    pub fn track_count(&self) -> usize {
        self.tracks.len()
    }

    /// Mixes one frame into `out`. Missing samples are silence; the level and
    /// speaking flag of every participant are updated even when it is muted.
    ///
    /// A track contributes only whole frames (stage 2.3.2c): if its ring holds
    /// less than one frame it stays silent for this frame, the read is not
    /// partial and the track re-primes. Returns the number of tracks that had
    /// no whole frame to deliver.
    pub fn mix(&mut self, out: &mut [i16]) -> u32 {
        let frames = out.len().min(FRAME_SAMPLES);
        let accum = &mut self.accumulator[..frames];
        accum.fill(0);
        let mut starved = 0u32;
        for track in &mut self.tracks {
            let playing = track.reader.read(&mut track.scratch);
            if !playing {
                starved += 1;
            }
            let level = track.smoother.update_frame(&track.scratch[..frames]);
            let speaking = track.detector.update(level);
            track
                .level
                .level_bits
                .store(f32::to_bits(level), Ordering::Relaxed);
            track.level.speaking.store(speaking, Ordering::Relaxed);
            if track.muted || track.volume <= 0.0 {
                continue;
            }
            // After the meters, so the speaking indicator and the level shown
            // in the UI describe the voice as sent, and before the user's own
            // volume, so the slider stays relative to the leveled voice. Stream
            // audio keeps its own dynamics: leveling music or game sound would
            // breathe with the scene and fight the stream volume (stage P25).
            if track.level_audio && !track.leveler.is_idle(self.leveling) {
                track
                    .leveler
                    .process(&mut track.scratch[..frames], self.leveling);
            }
            let gain = track.volume * self.master;
            for (index, sample) in track.scratch[..frames].iter().enumerate() {
                accum[index] += (f32::from(*sample) * gain) as i32;
            }
        }
        self.limiter.process(accum, out);
        for sample in &mut out[frames..] {
            *sample = 0;
        }
        starved
    }

    /// Drift trims of every track since the previous call.
    ///
    /// A trim is a bounded drop of frames when a ring ran ahead of the output
    /// clock (`track_trims` in the diagnostics); the quiet-frame drop below the
    /// hard limit is not counted.
    pub fn take_track_trims(&mut self) -> u32 {
        self.tracks
            .iter_mut()
            .map(|track| track.reader.take_trims())
            .sum()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn constant(value: i16) -> [i16; FRAME_SAMPLES] {
        [value; 480]
    }

    /// Pushes the jitter reserve so the track is allowed to play; the first
    /// [`FRAME_SAMPLES`] of it are what the next `mix` returns.
    fn prime(publisher: &mut TrackPublisher, frame: &[i16; FRAME_SAMPLES]) {
        for _ in 0..3 {
            publisher.push(frame);
        }
    }

    #[test]
    fn two_tracks_are_summed() {
        let mut mixer = Mixer::new();
        let (mut a, _) = mixer.add_track("alice");
        let (mut b, _) = mixer.add_track("bob");
        prime(&mut a, &constant(1_000));
        prime(&mut b, &constant(2_000));
        let mut out = [0i16; 480];
        mixer.mix(&mut out);
        assert!(out.iter().all(|sample| *sample == 3_000));
    }

    #[test]
    fn mixing_limits_instead_of_wrapping() {
        let mut mixer = Mixer::new();
        let (mut a, _) = mixer.add_track("alice");
        let (mut b, _) = mixer.add_track("bob");
        prime(&mut a, &constant(30_000));
        prime(&mut b, &constant(30_000));
        let mut out = [0i16; 480];
        mixer.mix(&mut out);
        // The sum is 60 000 on the 32-bit accumulator; it must neither wrap to
        // a negative value nor stay hard-clipped at the 16-bit rail.
        let limit = (CEILING * 32_768.0).floor() as i16;
        assert!(out.iter().all(|sample| *sample > 0));
        assert!(
            out.iter().all(|sample| *sample <= limit),
            "the final mix passed the ceiling: {:?}",
            out.iter().max()
        );
    }

    /// Stage P25 rework: measure the final mix of several leveled voices plus a
    /// stream at 100 % and 200 %. The per-track limiter sits before the user
    /// and master gains, so the sum used to hard-clip; the final limiter keeps
    /// it at -1 dBFS instead. The printed numbers are the real bounds used in
    /// the ADR and the handoff.
    #[test]
    fn the_final_mix_of_voices_and_a_stream_stays_below_the_ceiling() {
        // Worst case after the per-track limiter: each track peaks at about
        // -1 dBFS (29 000 of 32 767).
        let peak = constant(29_000);
        let limit = (CEILING * 32_768.0).floor() as i32;
        for (label, user, master) in [
            ("100/100", 1.0f32, 1.0f32),
            ("200/100", 2.0f32, 1.0f32),
            ("200/200", 2.0f32, 2.0f32),
        ] {
            let mut mixer = Mixer::new();
            let mut tracks = Vec::new();
            for identity in ["alice", "bob", "carol"] {
                let (mut voice, _) = mixer.add_track(identity);
                prime(&mut voice, &peak);
                mixer.set_volume(identity, user);
                tracks.push(voice);
            }
            let (mut stream, _) = mixer.add_stream_track("dave#screen_share_audio");
            prime(&mut stream, &peak);
            mixer.set_volume("dave#screen_share_audio", user);
            mixer.set_master_volume(master);
            tracks.push(stream);

            let mut out = [0i16; 480];
            let mut worst = 0i32;
            for _ in 0..60 {
                for track in &mut tracks {
                    track.push(&peak);
                }
                mixer.mix(&mut out);
                for sample in out {
                    worst = worst.max(i32::from(sample).abs());
                }
            }
            let unclipped = 4.0 * 29_000.0 * user * master;
            let cut_db = 20.0 * (worst as f32 / unclipped).log10();
            eprintln!(
                "final mix {label}: input sum {unclipped:.0} ({:.1} dBFS), peak {worst} \
                 ({:.1} dBFS), limiter {cut_db:.1} dB",
                20.0 * (unclipped / 32_768.0).log10(),
                20.0 * (worst as f32 / 32_768.0).log10()
            );
            assert!(
                worst <= limit + 1,
                "{label}: the final mix clipped at {worst}"
            );
        }
    }

    /// The limiter must not colour a stream that is already below the ceiling:
    /// the same samples come out bit for bit.
    #[test]
    fn a_stream_below_the_ceiling_passes_bit_exact() {
        let mut mixer = Mixer::new();
        let (mut stream, _) = mixer.add_stream_track("bob#screen_share_audio");
        let quiet = constant(20_000);
        prime(&mut stream, &quiet);
        let mut out = [0i16; 480];
        for _ in 0..10 {
            stream.push(&quiet);
            mixer.mix(&mut out);
            assert!(out.iter().all(|sample| *sample == 20_000));
        }
    }

    /// Rail of the final limiter in 16-bit units: -1 dBFS.
    fn rail() -> i32 {
        (CEILING * 32_768.0).floor() as i32
    }

    /// One 10 ms block of a 500 Hz cosine. `start` is the sample offset in the
    /// continuous wave, so `start = 0` puts a full peak on the first sample and
    /// other offsets move the peak across the block.
    fn cosine_block(peak: f32, start: usize) -> [i32; FRAME_SAMPLES] {
        let mut block = [0i32; FRAME_SAMPLES];
        for (index, sample) in block.iter_mut().enumerate() {
            let phase = 2.0 * std::f32::consts::PI * 500.0 * (start + index) as f32 / 48_000.0;
            *sample = (peak * phase.cos()).round() as i32;
        }
        block
    }

    /// Index of the first pair of neighbouring samples that both sit on the
    /// rail, i.e. a flat top. A scaled attack touches the rail at a single
    /// sample instead.
    fn flat_top(out: &[i16]) -> Option<usize> {
        let edge = (rail() - 1) as u16;
        out.windows(2)
            .position(|pair| pair[0].unsigned_abs() >= edge && pair[1].unsigned_abs() >= edge)
    }

    /// Stage P25 rework, review §87 blocker: 500 Hz at 48 kHz with the first
    /// peak of 115 000 on the first sample (four tracks at the track ceiling and
    /// 200 % gains). The old 1 ms attack ramp left 33 of the first 48 samples
    /// clamped flat at -1 dBFS, which is audible distortion. The limiter now
    /// reads the block it has already gathered and scales it as a whole, so only
    /// the peak sample reaches the rail and the sine keeps its shape.
    #[test]
    fn a_hot_sine_attack_is_scaled_not_flattened() {
        let mut limiter = MixLimiter::new();
        let mut out = [0i16; FRAME_SAMPLES];
        let block = cosine_block(115_000.0, 0);
        assert_eq!(
            block[0], 115_000,
            "the fixture must peak on the first sample"
        );
        limiter.process(&block, &mut out);

        let edge = rail();
        assert!(
            out.iter()
                .all(|sample| i32::from(sample.unsigned_abs()) <= edge),
            "the block passed the ceiling"
        );
        if let Some(index) = flat_top(&out) {
            panic!("the attack left a flat top at sample {index}");
        }
        let at_rail = out
            .iter()
            .filter(|sample| i32::from(sample.unsigned_abs()) >= edge - 1)
            .count();
        eprintln!(
            "hot attack: input peak {} -> output peak {} (rail {edge}), \
             {at_rail} sample(s) on the rail, neighbour {}",
            block[0], out[0], out[1]
        );
        // One sample at the rail, its neighbours clearly below: the output is a
        // quieter sine, not a clipped one.
        assert!(i32::from(out[0].unsigned_abs()) >= edge - 1);
        assert!(i32::from(out[1].unsigned_abs()) < edge - 4);
    }

    /// The guard must hold for peaks that fall on any sample of the block and
    /// for levels just above the ceiling as well as far above it.
    #[test]
    fn attacks_from_any_sample_hold_the_ceiling_without_a_flat_top() {
        let edge = rail();
        for peak in [
            115_000.0f32,
            90_000.0,
            60_000.0,
            40_000.0,
            29_205.0,
            20_000.0,
            29_204.0,
        ] {
            for start in [0usize, 7, 23, 48, 95, 191] {
                let input = cosine_block(peak, start);
                let mut limiter = MixLimiter::new();
                let mut out = [0i16; FRAME_SAMPLES];
                limiter.process(&input, &mut out);
                assert!(
                    out.iter()
                        .all(|sample| i32::from(sample.unsigned_abs()) <= edge),
                    "peak {peak} at offset {start} passed the ceiling"
                );
                if let Some(index) = flat_top(&out) {
                    panic!("peak {peak} at offset {start} left a flat top at {index}");
                }
                if peak <= edge as f32 {
                    // A mix at or below the ceiling stays bit-exact.
                    assert!(
                        out.iter()
                            .zip(input.iter())
                            .all(|(out, input)| i32::from(*out) == *input),
                        "peak {peak} at offset {start} was coloured below the ceiling"
                    );
                }
            }
        }
    }

    /// Repeated attacks and the recovery between them: every burst stays under
    /// the ceiling without a flat top, and after the loud part the gain returns
    /// smoothly — a quiet mix is never stepped and ends bit-exact.
    #[test]
    fn repeated_attacks_recover_without_a_step() {
        let edge = rail();
        let mut limiter = MixLimiter::new();
        let mut out = [0i16; FRAME_SAMPLES];
        for round in 0..4 {
            for peak in [115_000.0f32, 60_000.0] {
                limiter.process(&cosine_block(peak, round * 13), &mut out);
                assert!(
                    out.iter()
                        .all(|sample| i32::from(sample.unsigned_abs()) <= edge),
                    "round {round}, peak {peak}: the burst passed the ceiling"
                );
                if let Some(index) = flat_top(&out) {
                    panic!("round {round}, peak {peak}: flat top at sample {index}");
                }
            }
        }

        // The button of the level goes quiet: a DC mix at -12 dBFS. The gain
        // may only rise, by a fraction of a decibel per block, never in a step.
        let quiet = 8_000i16;
        let quiet_block = [i32::from(quiet); FRAME_SAMPLES];
        limiter.process(&quiet_block, &mut out);
        assert!(
            out[0] < quiet / 2,
            "the gain did not stay reduced after the attack: {}",
            out[0]
        );
        let mut previous = out[0];
        let mut biggest_step = 0i16;
        for block in 0..=260 {
            if block > 0 {
                limiter.process(&quiet_block, &mut out);
            }
            for (index, sample) in out.iter().enumerate() {
                if block == 0 && index == 0 {
                    continue;
                }
                assert!(
                    *sample >= previous,
                    "the gain fell back in block {block}: {sample} < {previous}"
                );
                biggest_step = biggest_step.max(*sample - previous);
                previous = *sample;
            }
        }
        assert_eq!(
            previous, quiet,
            "the gain never returned to unity after the release"
        );
        assert!(
            biggest_step <= 2,
            "the recovery stepped audibly: {biggest_step} LSB"
        );
    }

    #[test]
    fn leveling_is_off_by_default_and_switchable_live() {
        let mut mixer = Mixer::new();
        let (mut a, _) = mixer.add_track("alice");
        // A quiet but active voice: -34 dBFS RMS square wave.
        let quiet = constant(400);
        let mut out = [0i16; 480];
        prime(&mut a, &quiet);
        mixer.mix(&mut out);
        assert!(
            out.iter().all(|sample| *sample == 400),
            "default must be a pass-through"
        );
        mixer.set_leveling(true);
        let mut last = 400i16;
        for _ in 0..300 {
            a.push(&quiet);
            mixer.mix(&mut out);
            last = out[479];
        }
        assert!(
            last > 400,
            "three seconds of leveling must raise a quiet voice: {last}"
        );
        mixer.set_leveling(false);
        for _ in 0..200 {
            a.push(&quiet);
            mixer.mix(&mut out);
        }
        assert!(
            out.iter().all(|sample| *sample == 400),
            "off must return to unity"
        );
    }

    #[test]
    fn leveling_does_not_change_the_speaking_meter() {
        let mut mixer = Mixer::new();
        mixer.set_leveling(true);
        let (mut a, level) = mixer.add_track("alice");
        let loud = constant(20_000);
        prime(&mut a, &loud);
        let mut out = [0i16; 480];
        for _ in 0..100 {
            a.push(&loud);
            mixer.mix(&mut out);
        }
        // The meter reports the voice as received (about -4 dBFS), not the
        // leveled one (about -22 dBFS).
        assert!(level.level_db() > -8.0, "meter was {}", level.level_db());
    }

    /// Stage P25: leveling is for speech. Game and music audio share the
    /// mixer, so it must pass through with its own dynamics; only the voice
    /// track may move.
    #[test]
    fn leveling_raises_a_voice_but_leaves_stream_audio_alone() {
        let mut mixer = Mixer::new();
        mixer.set_leveling(true);
        let (mut voice, _) = mixer.add_track("alice");
        let (mut stream, _) = mixer.add_stream_track("bob#screen_share_audio");
        let quiet = constant(400);
        prime(&mut voice, &quiet);
        prime(&mut stream, &quiet);
        let mut out = [0i16; 480];
        let mut last = 0i16;
        for _ in 0..900 {
            voice.push(&quiet);
            stream.push(&quiet);
            mixer.mix(&mut out);
            last = out[479];
        }
        assert!(
            last > 400,
            "the voice was not leveled at all: {last} on top of the stream"
        );
        // Mute the voice: what remains is the stream track alone. It must be
        // bit-identical to its input even though leveling is on.
        mixer.set_muted("alice", true);
        for _ in 0..10 {
            voice.push(&quiet);
            stream.push(&quiet);
            mixer.mix(&mut out);
            assert!(
                out.iter().all(|sample| *sample == 400),
                "the stream audio was leveled: {}",
                out[479]
            );
        }
    }

    #[test]
    fn volume_scales_a_track() {
        let mut mixer = Mixer::new();
        let (mut a, _) = mixer.add_track("alice");
        mixer.set_volume("alice", 0.5);
        prime(&mut a, &constant(10_000));
        let mut out = [0i16; 480];
        mixer.mix(&mut out);
        assert!(out.iter().all(|sample| *sample == 5_000));
    }

    #[test]
    fn volume_is_clamped_to_two_hundred_percent() {
        let mut mixer = Mixer::new();
        let (mut a, _) = mixer.add_track("alice");
        mixer.set_volume("alice", 9.0);
        prime(&mut a, &constant(10_000));
        let mut out = [0i16; 480];
        mixer.mix(&mut out);
        assert!(out.iter().all(|sample| *sample == 20_000));
    }

    #[test]
    fn a_muted_track_is_silent_but_still_measured() {
        let mut mixer = Mixer::new();
        let (mut a, level) = mixer.add_track("alice");
        mixer.set_muted("alice", true);
        prime(&mut a, &constant(20_000));
        let mut out = [0i16; 480];
        mixer.mix(&mut out);
        assert!(out.iter().all(|sample| *sample == 0));
        assert!(level.level_db() > -12.0);
        assert!(level.is_speaking());
    }

    #[test]
    fn missing_track_audio_is_counted_and_mixed_as_silence() {
        let mut mixer = Mixer::new();
        let (_a, _) = mixer.add_track("alice");
        let mut out = [7i16; 480];
        let starved = mixer.mix(&mut out);
        assert_eq!(starved, 1);
        assert!(out.iter().all(|sample| *sample == 0));
    }

    /// A new track waits for the 30 ms reserve before it plays; a short ring
    /// makes it wait again instead of mixing partly read audio (stage 2.3.2c).
    #[test]
    fn a_track_waits_for_the_reserve_and_never_mixes_a_partial_frame() {
        let mut mixer = Mixer::new();
        let (mut a, _) = mixer.add_track("alice");
        let mut out = [0i16; 480];

        a.push(&[1_000i16; 240]);
        assert_eq!(mixer.mix(&mut out), 1);
        assert!(
            out.iter().all(|sample| *sample == 0),
            "partial frame leaked"
        );

        // The 240 samples were kept: another 1 200 complete the reserve.
        a.push(&[1_000i16; 1_200]);
        assert_eq!(mixer.mix(&mut out), 0);
        assert!(
            out.iter().all(|sample| *sample == 1_000),
            "the whole frame at the head of the ring must be mixed"
        );

        // Two more frames were in the reserve behind the one just read; the
        // next read finds the ring empty and re-primes instead of mixing a
        // partial frame.
        a.push(&[1_000i16; FRAME_SAMPLES]);
        assert_eq!(mixer.mix(&mut out), 0);
        assert_eq!(mixer.mix(&mut out), 0);
        assert_eq!(mixer.mix(&mut out), 0);
        assert_eq!(mixer.mix(&mut out), 1, "the empty track must re-prime");
        assert!(out.iter().all(|sample| *sample == 0));
    }

    #[test]
    fn removing_a_track_stops_its_audio() {
        let mut mixer = Mixer::new();
        let (mut a, _) = mixer.add_track("alice");
        prime(&mut a, &constant(5_000));
        mixer.remove_track("alice");
        assert_eq!(mixer.track_count(), 0);
        let mut out = [0i16; 480];
        mixer.mix(&mut out);
        assert!(out.iter().all(|sample| *sample == 0));
    }

    #[test]
    fn adding_the_same_identity_replaces_the_old_ring() {
        let mut mixer = Mixer::new();
        let (mut old, _) = mixer.add_track("alice");
        old.push(&constant(5_000));
        let (mut fresh, _) = mixer.add_track("alice");
        prime(&mut fresh, &constant(1_000));
        assert_eq!(mixer.track_count(), 1);
        let mut out = [0i16; 480];
        mixer.mix(&mut out);
        assert!(out.iter().all(|sample| *sample == 1_000));
    }

    #[test]
    fn a_full_ring_does_not_block_or_panic() {
        let mut mixer = Mixer::new();
        let (mut a, _) = mixer.add_track("alice");
        let frame = constant(1_000);
        for _ in 0..200 {
            a.push(&frame);
        }
        assert!(a.dropped() > 0);
    }

    /// Above 80 ms a quiet frame is dropped without a counter and without an
    /// audible gap; loud speech is left alone below the hard limit.
    #[test]
    fn drift_drops_a_quiet_frame_but_keeps_loud_speech() {
        let mut mixer = Mixer::new();
        let (mut a, _) = mixer.add_track("alice");
        // Nine frames: three silent ones at the head (the reserve and one
        // more) and six loud ones. The oldest frame is quiet, so exactly one
        // of the three silent frames must disappear.
        for _ in 0..3 {
            a.push(&constant(0));
        }
        for _ in 0..6 {
            a.push(&constant(1_000));
        }
        let mut out = [0i16; 480];
        let mut silent = 0;
        loop {
            assert_eq!(mixer.mix(&mut out), 0, "the track must keep playing");
            if out[0] == 1_000 {
                break;
            }
            silent += 1;
            assert!(silent <= 4, "no quiet frame was dropped");
        }
        assert_eq!(silent, 2, "one of three silent frames must be dropped");
        assert_eq!(mixer.take_track_trims(), 0, "a quiet drop is not a trim");

        // The same backlog of loud frames is not trimmed.
        let mut mixer = Mixer::new();
        let (mut b, _) = mixer.add_track("bob");
        for _ in 0..9 {
            b.push(&constant(1_000));
        }
        let mut loud = 0;
        while mixer.mix(&mut out) == 0 {
            loud += 1;
            assert!(loud <= 12, "the loud track must not lose frames");
        }
        assert_eq!(loud, 9, "loud frames must not be dropped");
        assert_eq!(mixer.take_track_trims(), 0);
    }

    /// A source slower than the output clock is followed sample by sample: the
    /// ring never runs dry and no whole frame is dropped or repeated.
    #[test]
    fn a_slow_source_is_followed_sample_by_sample() {
        let mut mixer = Mixer::new();
        let (mut a, _) = mixer.add_track("alice");
        for _ in 0..3 {
            a.push(&constant(1_000));
        }
        let mut out = [0i16; 480];
        assert_eq!(mixer.mix(&mut out), 0, "the reserve must be enough");

        // 1 % slower than the reader: with whole-frame steps this would be a
        // 10 ms hole every second. The elastic read stretches instead.
        let mut starved = 0;
        for _ in 0..300 {
            a.push(&[1_000i16; 475]);
            if mixer.mix(&mut out) != 0 {
                starved += 1;
            }
            assert!(out.iter().all(|sample| *sample == 1_000));
        }
        assert_eq!(starved, 0, "the slow source must never starve the track");
        assert_eq!(mixer.take_track_trims(), 0);
    }

    /// Past 200 ms the backlog is trimmed to the reserve without conditions,
    /// and the event is counted (stage 2.3.2c).
    #[test]
    fn a_backlog_past_the_limit_is_trimmed_to_the_reserve() {
        let mut mixer = Mixer::new();
        let (mut a, _) = mixer.add_track("alice");
        for _ in 0..TRACK_MAX / FRAME_SAMPLES + 1 {
            a.push(&constant(1_000));
        }
        let mut out = [0i16; 480];
        assert_eq!(mixer.mix(&mut out), 0);
        assert_eq!(mixer.take_track_trims(), 1);
        // One read and the trim left the reserve: two more frames play, then
        // the track starves.
        let mut played = 1;
        while mixer.mix(&mut out) == 0 {
            played += 1;
            assert!(played <= 4, "the trim left more than the reserve");
        }
        assert_eq!(played, 3);
    }
}
